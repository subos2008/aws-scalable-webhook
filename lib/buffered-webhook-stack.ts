import * as cdk from "@aws-cdk/core"
import lambda = require("@aws-cdk/aws-lambda")
import apigw = require("@aws-cdk/aws-apigateway") // Note this seems to use @aws-cdk/aws-apigatewayv2 (version 2)
import sqs = require("@aws-cdk/aws-sqs")
import * as ssm from "@aws-cdk/aws-ssm"
import { SqsEventSource } from "@aws-cdk/aws-lambda-event-sources"
import dynamodb = require("@aws-cdk/aws-dynamodb")
// import { Datadog } from "datadog-cdk-constructs"
import * as route53 from "@aws-cdk/aws-route53"
import * as targets from "@aws-cdk/aws-route53-targets"
import * as acm from "@aws-cdk/aws-certificatemanager"
import { Config } from "./config"
import { RetentionDays } from "@aws-cdk/aws-logs"
import * as cwlogs from "@aws-cdk/aws-logs"

/**
 * Manage the buffered webhook stack using CDK
 */
export class BufferedWebhookStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: cdk.StackProps, config: Config) {
    super(scope, id, props)

    let lambdas_list = []

    /**
     * Faux Backend
     *
     * Only used for testing - a faux backend that just logs what it receives
     */
    let backend_url: string = config.backend_url // include https:// at the beginning
    let fauxBackendLambda, faux_backend_apigw

    if (config.create_faux_backend) {
      if (backend_url) console.warn(`Overriding backend_url with faux backend`)
      // defines an AWS Lambda resource to publish to our queue
      fauxBackendLambda = new lambda.Function(this, "FauxBackendLambdaHandler", {
        logRetention: RetentionDays.THREE_MONTHS,
        runtime: lambda.Runtime.NODEJS_14_X, // execution environment
        code: lambda.Code.fromAsset("lambda-fns/faux-backend"),
        handler: "lambda.handler", // file is "lambda", function is "handler"
        memorySize: 256,
        environment: {
          SENTRY_DSN: config.sentryDsn,
        },
        functionName: `${this.stackName}-faux-backend`,
        // layers: [{ layerVersionArn: 'arn:aws:lambda:us-east-1:943013980633:layer:SentryNodeServerlessSDK:13' }]
      })
      lambdas_list.push(fauxBackendLambda)
      cdk.Tags.of(fauxBackendLambda).add("function", "faux-backend")

      // defines an API Gateway REST API resource backed by our "fauxBackendLambda" function.
      faux_backend_apigw = new apigw.LambdaRestApi(this, `FauxBackend-${this.stackName}`, {
        handler: fauxBackendLambda,
      })

      backend_url = faux_backend_apigw.urlForPath(`/`) // API GW urls contain a stage path, i.e: /prod/
      new cdk.CfnOutput(this, "Faux Backend Lambda LogGroup Name", {
        value: fauxBackendLambda.logGroup.logGroupName,
      })
      new cdk.CfnOutput(this, "Faux Backend Lambda LogGroup ARN", {
        value: fauxBackendLambda.logGroup.logGroupArn,
      })
      new cdk.CfnOutput(this, "Uses Faux Backend", {
        value: "true", // Used by the tests
      })
    }

    new cdk.CfnOutput(this, "Backend Hostname", {
      value: backend_url,
    })

    /**
     * DynamoDB
     *
     * This is standing in for what is S3 on the diagram due to simpler/cheaper setup
     */
    const table = new dynamodb.Table(this, "Messages", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING }, //the key being id means we squash duplicate sqs messages
    })
    // A manually named output
    new cdk.CfnOutput(this, "DynamoDB Table", {
      value: table.tableName,
    })

    /**
     * SQS Queue
     *
     * Creates the FIFO queue to be used by our publisher and subscriber lambdas.
     */
    const queue = new sqs.Queue(this, "PublishQueue", {
      fifo: true,
      contentBasedDeduplication: true, // assume that any messages with the same content are duplicates and ignore them
    })

    /**
     * Publisher Lambda
     *
     * Defines a lambda resource to publish messages to our SQS queue.
     */
    const sqsPublishLambda = new lambda.Function(this, "SQSPublishLambdaHandler", {
      logRetention: RetentionDays.THREE_MONTHS,
      runtime: lambda.Runtime.NODEJS_14_X, // execution environment
      code: lambda.Code.fromAsset("lambda-fns/publish"), // code loaded from the "lambda-fns/publish" directory
      handler: "lambda.handler", // file is "lambda", function is "handler"
      memorySize: 256,
      environment: {
        queueURL: queue.queueUrl,
        SENTRY_DSN: config.sentryDsn,
        SERVICE_NAME: config.service,
        ENV: config.environment,
        DD_FLUSH_TO_LOG: "true",
        DD_TRACE_ENABLED: "true",
        DD_LOGS_INJECTION: "true",
      },
      functionName: `${this.stackName}-publish-to-sqs`,
    })
    lambdas_list.push(sqsPublishLambda)
    new cdk.CfnOutput(this, "sqsPublishLambda LogGroup ARN", {
      value: sqsPublishLambda.logGroup.logGroupArn,
    })
    queue.grantSendMessages(sqsPublishLambda)
    cdk.Tags.of(sqsPublishLambda).add("function", "publish")

    /**
     * Subscriber Lambda
     *
     * Defines a lambda resource to pull from the SQS queue and make requests
     * to backend endpoints.
     */
    const sqsSubscribeLambda = new lambda.Function(this, "SQSSubscribeLambdaHandler", {
      logRetention: RetentionDays.THREE_MONTHS,
      runtime: lambda.Runtime.NODEJS_14_X, // execution environment
      code: lambda.Code.fromAsset("lambda-fns/subscribe"), // code loaded from the "lambda-fns/subscribe" directory
      timeout: cdk.Duration.seconds(10), // Needs to be about 5, 3 times out
      memorySize: 256,
      handler: "lambda.handler", // file is "lambda", function is "handler"
      reservedConcurrentExecutions: 2, // throttle lambda to 2 concurrent invocations, note this is not the same as batchSize below and can probably be increased
      environment: {
        tableName: table.tableName,
        backend_url,
        SENTRY_DSN: config.sentryDsn,
        SERVICE_NAME: config.service,
        ENV: config.environment,
      },
      functionName: `${this.stackName}-subscribe-to-sqs`,
    })
    lambdas_list.push(sqsSubscribeLambda)
    queue.grantConsumeMessages(sqsSubscribeLambda)

    /* WARNING: it is very important the batchSize is set to 1 (one).
     * c.f: Partial Failures in https://lumigo.io/blog/sqs-and-lambda-the-missing-guide-on-failure-modes/
     * It is also important to keep this at 1 because otherwise we suddenly (only) get 10 events during high load
     * situations and start timing out the lambda execution trying to do ten events in one invocation.
     */
    sqsSubscribeLambda.addEventSource(new SqsEventSource(queue, { batchSize: 1 }))
    cdk.Tags.of(sqsSubscribeLambda).add("function", "subscribe")

    table.grantReadWriteData(sqsSubscribeLambda)
    new cdk.CfnOutput(this, "sqsSubscribeLambda LogGroup ARN", {
      value: sqsSubscribeLambda.logGroup.logGroupArn,
    })

    /**
     * API Gateway Proxy
     *
     * Used to expose the webhook through a URL. Defines an API Gateway REST API resource backed by our "sqsPublishLambda" function.
     */
    const log_group = new cwlogs.LogGroup(this, "apigw")
    let api = new apigw.LambdaRestApi(this, `SolidusBufferedEndpoint-${this.stackName}`, {
      handler: sqsPublishLambda,
      deployOptions: {
        accessLogDestination: new apigw.LogGroupLogDestination(log_group),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
      },
      domainName: {
        domainName: `${config.subdomain}.${config.domain}`, // we need to generate a new cert for *.api.* if we want to use sqs.api.*
        certificate: acm.Certificate.fromCertificateArn(
          this,
          "Certificate",
          config.acmCertificateArn
        ),
      },
    })

    new cdk.CfnOutput(this, "DeploymentStage", {
      value: api.deploymentStage.stageName,
    })
    new cdk.CfnOutput(this, "SolidusBufferedEndpoint", {
      value: api.urlForPath("/"),
    })

    /**
     * Route53 Record
     *
     * Custom domain name for the API Gateway endpoint.
     */
    new route53.ARecord(this, "CustomDomainAliasRecord", {
      zone: route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: config.domain,
      }),
      target: route53.RecordTarget.fromAlias(new targets.ApiGateway(api)),
      recordName: config.subdomain,
      ttl: cdk.Duration.seconds(300),
    })

    /**
     * Datadog macro
     *
     * Automatically instruments the lambdas in `lambdas_list` with Datadog.
     */
    // const DD_API_KEY = ssm.StringParameter.fromStringParameterAttributes(this, "DD_API_KEY", {
    //   parameterName: "/global/DD_API_KEY",
    // }).stringValue

    // const datadog = new Datadog(this, "DatadogMain", {
    //   nodeLayerVersion: 52, // Latest version from Github releases page
    //   addLayers: true,
    //   flushMetricsToLogs: true,
    //   injectLogContext: true,
    //   enableDatadogTracing: true,
    //   forwarderArn: config.forwarderArn,
    // })

    // datadog.addLambdaFunctions(lambdas_list)

    new cdk.CfnOutput(this, "AWS_REGION", {
      value: config.awsRegion,
    })
  }
}

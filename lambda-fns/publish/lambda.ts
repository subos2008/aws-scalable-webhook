import * as AWS from "aws-sdk"
// Seems not to be APIGatewayProxyHandlerV2 - why not?
import { APIGatewayProxyHandler, APIGatewayProxyResult, APIGatewayProxyEvent } from "aws-lambda"
import { EventRequest, EventBody } from "../../types/event"

import { Logger } from "./logger"
const log = new Logger({})

import withSentry from "serverless-sentry-lib" // This helper library
import * as Sentry from "@sentry/node"

// Unpack Environment Variables
let QueueUrl: string
if (process.env.queueURL) {
  QueueUrl = process.env.queueURL
} else {
  Sentry.captureMessage(`queueURL is not defined in environment`, Sentry.Severity.Error)
  throw new Error(`queueURL is not defined in environment`)
}

// Per event context settings / info
type HandlerContext = {
  suppress_sentry: boolean
}

function event_to_group_id(context: HandlerContext, event: APIGatewayProxyEvent): string {
  return 'grouping-disabled'
}

let api_gw_handler: APIGatewayProxyHandler = async function (request): Promise<APIGatewayProxyResult> {
  var sqs = new AWS.SQS({ apiVersion: "2012-11-05" })

  let event_request: EventRequest = {
    path: request.path,
    headers: request.headers,
    body: request.body,
    httpMethod: request.httpMethod,
    queryStringParameters: request.queryStringParameters,
  }

  let sqs_event_body: EventBody = {
    request: event_request,
    received_timestamp: new Date().getTime(),
  }

  let context: HandlerContext = {
    suppress_sentry: false,
  }

  try {
    // Peek inside the body, at the moment this is used by the test rig that passes us supression
    // flags so we don't spam sentry when testing unhappy paths
    if (request.body) {
      let json_body = JSON.parse(request.body)
      if (json_body.suppress_sentry) context.suppress_sentry = true
    }
  } catch (e) {
    Sentry.captureException(e)
  }

  // "MessageGroupId is the tag that specifies that a message belongs to a specific message group.
  //  Messages that belong to the same message group are always processed one by one, in a strict
  //  order relative to the message group (however, messages that belong to different message groups
  //  might be processed out of order).
  let MessageGroupId
  try {
    MessageGroupId = event_to_group_id(context, request)
  } catch (e) {
    return sendRes(400, JSON.stringify({ msg: "Unable to determine MessageGroupId" }))
  }

  var params = {
    // c.f. https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagegroupid-property.html
    MessageGroupId,
    MessageBody: JSON.stringify(sqs_event_body),
    QueueUrl,
  }

  let response = sendRes(500, JSON.stringify({ msg: "Default Error" }))

  let message_id = null
  try {
    await sqs
      .sendMessage(params, function (err, data) {
        if (err) {
          let msg = `Error submitting event to SQS`
          log.error(msg, err)
          response = sendRes(500, JSON.stringify({ msg, error: err }))
          Sentry.captureException(new Error(msg), {
            extra: {
              sqs_response: err,
            },
            tags: {
              message: err.message,
              code: err.code,
              error: err.name,
              message_id: data.MessageId,
              statusCode: err.statusCode,
            },
          })
        } else {
          message_id = data.MessageId
          response = sendRes(
            200,
            JSON.stringify({
              msg: "You have added a message to the queue! Message ID is " + data.MessageId,
              message_id: data.MessageId,
            })
          )
        }
      })
      .promise()
  } catch (error) {
    log.error(`Exception calling sqs.sendMessage`, error)
    Sentry.captureException(error)
    response = sendRes(500, JSON.stringify({ msg: "See logs" }))
  }

  // decorate the event with the results of publishing to the queue and print to logs
  sqs_event_body["sqs_publish_result"] = {
    return_code: response.statusCode,
    body: response.body,
    message_id,
  }

  if (sqs_event_body.sqs_publish_result.return_code == 200) {
    log.info(`Successfully published event to SQS`, sqs_event_body)
  } else {
    log.error(`Failed to publish event to SQS`, sqs_event_body)
  }

  return response
}

let sendRes = (status: number, body: string) => {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
    },
    body: body,
  }
}

// c.f: https://github.com/arabold/serverless-sentry-lib/blob/master/README.md
const withSentryOptions = {
  scope: {
    tags: {
      lambda_stage: "publish",
    },
  },
  captureErrors: true,
  captureUnhandledRejections: true,
  captureUncaughtException: true,
  captureMemory: true,
  captureTimeouts: true,
}

// Have call to withSentry before other top-level code that might trigger exceptions
export const handler = withSentry(withSentryOptions, api_gw_handler)

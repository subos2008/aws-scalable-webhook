#!/usr/bin/env node
import "source-map-support/register"
import * as cdk from "@aws-cdk/core"
import { BufferedWebhookStack } from "../lib/buffered-webhook-stack"
import { Config } from "../lib/config"

const app = new cdk.App()

/**
 * Ensure configuration values are strings
 *
 * @param object
 * @param propName
 * @returns
 */
function ensureString(object: { [name: string]: any }, propName: string): string {
  if (!object[propName] || object[propName].trim().length === 0)
    throw new Error(`${propName} does not exist or is empty`)

  return object[propName]
}

/**
 * Ensure configuration values are boolean
 *
 * @param object
 * @param propName
 * @returns
 */
function ensureBoolean(object: { [name: string]: any }, propName: string): boolean {
  if (typeof object[propName] !== "boolean")
    throw new Error(`${propName} does not exist, is empty or is not a boolean`)

  return object[propName]
}

/**
 * Populate Config with the environment context.
 *
 * @returns Config
 */
function getConfig() {
  let env = app.node.tryGetContext("config")
  if (!env) throw new Error("Context variable missing on CDK command, pass in as `--env=<env>`")

  let context = app.node.tryGetContext(env)

  let config: Config = {
    awsAccount: ensureString(context, "awsAccount"),
    awsRegion: ensureString(context, "awsRegion"),

    service: ensureString(context, "service"),
    environment: ensureString(context, "environment"),

    domain: ensureString(context, "domain"),
    subdomain: ensureString(context, "subdomain"),
    acmCertificateArn: ensureString(context, "acmCertificateArn"),
    // forwarderArn: ensureString(context, "forwarderArn"),
    sentryDsn: ensureString(context, "sentryDsn"),
    create_faux_backend: ensureBoolean(context, "create_faux_backend"),
    backend_url: ensureString(context, "backend_url"),
  }

  return config
}

/**
 * Initiate the stack.
 */
async function main() {
  let config: Config = getConfig()
  let stackName: string = `${config.service}-${config.environment}`

  const stack = new BufferedWebhookStack(
    app,
    stackName,
    {
      env: {
        account: config.awsAccount,
        region: config.awsRegion,
      },
      tags: {
        automation: "cdk",
        env: config.environment,
        Environment: config.environment,
        service: config.service,
      },
    },
    config
  )
}
main()

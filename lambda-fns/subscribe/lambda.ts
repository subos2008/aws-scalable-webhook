import {
  DynamoDBClient,
  PutItemCommand,
  PutItemCommandOutput,
  PutItemCommandInput,
  UpdateItemCommand,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb"

import { EventRequest, EventBody } from "../../types/event"
import { URL, URLSearchParams } from "url"
import axios, { AxiosResponse } from "axios"
import { AxiosRequestConfig, Method } from "axios"
import { SQSHandler, SQSRecord } from "aws-lambda"

import { Logger } from "./logger"
const log = new Logger({})

import withSentry from "serverless-sentry-lib" // This helper library
import * as Sentry from "@sentry/node"

log.info(`Process starting.`)
log.info(`SENTRY_DSN: ${process.env.SENTRY_DSN}`)

// Per event context settings / info
type HandlerContext = {
  // suppress_sentry: at the moment this is used by the test rig that passes us supression
  // flags so we don't spam sentry when testing unhappy paths
  suppress_sentry: boolean
  // Also used by the test rig to mark messages we expect not to process sucessfully
  consume_bad_messages: boolean
}

let api_gw_handler: SQSHandler = async function (event, context, callback) {
  let records: SQSRecord[] = event.Records
  log.info(`Received ${records.length} events`, records)

  if (records.length > 1) {
    throw new Error(
      `records.length > 1 in handler (${records.length}), this is unexpected and breaks our ability to mark individual messages as pass or fail - aborting`
    )
  }

  let record = records[0]
  let message_id = record_to_message_id(record)
  await handle_record(record)
  log.info(`Completed processing record ${message_id},`, record)
}

// c.f: https://github.com/arabold/serverless-sentry-lib/blob/master/README.md
const withSentryOptions = {
  scope: {
    tags: {
      lambda_stage: "subscribe",
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

log.info("Starting new process, environment:", process.env)

// Unpack Environment Variables
if (!process.env.tableName) {
  Sentry.captureMessage(`tableName is not defined in environment`, Sentry.Severity.Error)
  throw new Error(`tableName is not defined in environment`)
}
let TableName: string = process.env.tableName

if (!process.env.backend_url) {
  Sentry.captureMessage(`backend_url is not defined in environment`, Sentry.Severity.Error)
  throw new Error(`backend_url is not defined in environment`)
}
let backend_url: string = process.env.backend_url

// TODO: haven't seen this working submitting to sentry yet. Apparently AWS also uses exception handlers
// and conflicts with the Sentry handlers
// throw new Error('Checking top level exceptions')

const dbclient = new DynamoDBClient({})

// NB: make sure this doesn't throw as it's used when logging errors
function record_to_message_id(record: SQSRecord): string {
  if (record.messageId) return record.messageId
  Sentry.captureException(new Error("messageId is null in record"), { extra: { record } })
  log.error("Failed to determine message_id for record", record)
  return "FAILED TO DETERMINE MESSAGE ID"
}

async function handle_record(record: SQSRecord) {
  log.info(`SQS record`, record)
  let event_body: EventBody = JSON.parse(record.body)
  let request = event_body.request
  log.info("Request", request)
  let group_id = record.attributes.MessageGroupId
  if (!group_id) {
    Sentry.captureException(new Error(`MessageGroupId missing in event`), {
      extra: { event_body: request },
    })
  }
  let sentry_extras: any = { event_body: request, group_id }

  let message_id = record_to_message_id(record)

  // Used by the smoke tests to prevent deliberate bad messages from blocking the queue
  let context: HandlerContext = {
    suppress_sentry: false,
    consume_bad_messages: false,
  }
  try {
    let body: any = event_body.request.body
    if (body) {
      body = JSON.parse(body)
      if (body.consume_bad_messages) context.consume_bad_messages = true
      if (body.suppress_sentry) context.suppress_sentry = true
    }
  } catch (e) {
    log.warn(`Error parsing debug context from body`)
  }

  // Stage 1: add the event we are about to send to the backend to dynamoDB
  try {
    var params: PutItemCommandInput = {
      TableName,
      Item: {
        group_id: { S: group_id as string },
        received_timestamp: { N: `${event_body.received_timestamp}` },
        request: { S: JSON.stringify(event_body.request) },
        message_id: { S: `${message_id}` },
        id: { S: `${record.messageId}` },
      },
    }
    log.info("DynamoDB item parameters", params)

    // Call DynamoDB to add the item to the table
    let cmd = new PutItemCommand(params)
    const data: PutItemCommandOutput = await dbclient.send(cmd)
    log.info("Success adding request info for message to DynamoDB", {
      message_id,
    })
  } catch (error) {
    // Note: we catch this separately so even if dynamoDB is down it doesn't affect
    // the call to the backend
    log.error(`Failed to store message in dynamoDB: ${record_to_message_id(record)}`, { record })
    Sentry.captureException(error)
  }

  // Stage 2: Call the backend
  let axios_response: AxiosResponse | null = null
  try {
    // Remove any leading slash on the path. A leading slash will make URL() interpret the path as
    // absolute and then it cuts out any path from the backend_url: AWS GW urls contain the env
    // as a prefix on the path
    const url = new URL(request.path.replace(/^\//, ""), backend_url)
    sentry_extras.backend_url = url.toString()
    if (request.queryStringParameters)
      url.search = "?" + new URLSearchParams(request.queryStringParameters).toString() // is the ? included in this or not? Might need to prefix it
    log.info(`Contacting backend on ${url.toString()}`)
    let request_config: AxiosRequestConfig = {
      method: request.httpMethod as Method,
      url: url.toString(),
      data: request.body,
    }
    sentry_extras.backend_request = request_config
    axios_response = await axios(request_config)
    log.info(
      `Backend call response for message_id ${record_to_message_id(record)}:`,
      axios_response
    )
  } catch (error) {
    // Some non-200 status codes will throw an exception
    axios_response = error.response
    if (context.suppress_sentry) {
      log.info(error)
    } else {
      log.error(
        `Exception calling backend for message_id ${record_to_message_id(record)} ${error}`,
        error
      )
      Sentry.captureException(error, { extra: sentry_extras })
      log.warn(
        `Backend call response for message_id ${record_to_message_id(record)}`,
        axios_response
      )
    }
  }
  let backend_response_status_code: string = `${axios_response?.status}`

  // Stage 3: Store the result of the backend call in DynamoDB
  try {
    let params: UpdateItemCommandInput = {
      TableName,
      Key: { id: { S: `${record.messageId}` } },
      UpdateExpression: "set backend_response_status_code=:status_code",
      ExpressionAttributeValues: {
        ":status_code": { "N": backend_response_status_code },
      },
    }
    log.info("DynamoDB item parameters", params)

    // Call DynamoDB to add the item to the table
    let cmd = new UpdateItemCommand(params)
    const data: PutItemCommandOutput = await dbclient.send(cmd)
    log.info("Success adding response info for backend call to DynamoDB", {
      message_id,
    })
  } catch (error) {
    // Note: we catch this separately so even if dynamoDB is down it doesn't affect
    // the call to the backend
    log.error(`Failed to store message in dynamoDB: ${record_to_message_id(record)}`, { record })
    Sentry.captureException(error)
  }

  if (Number(backend_response_status_code) >= 300) {
    let e = new Error(
      `Got a bad status code from the backend, throwing so the message is not consumed. Status ${backend_response_status_code}`
    ) // rethrow the error if we can't contact the backend properly as we don't want to consume the message from SQS
    if (!context.suppress_sentry) Sentry.captureException(e)
    if (!context.consume_bad_messages) throw e
  }
}

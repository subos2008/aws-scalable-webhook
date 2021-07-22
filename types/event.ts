export type QueryStringParameters = {
  [name: string]: string | undefined;
}

export type Headers = {
  [name: string]: string | undefined;
}

export type SQSPublishResult = {
  return_code: Number
  body: string
  message_id: string | null
}

export type EventRequest = {
  path: string
  headers: Headers
  body: string | null
  httpMethod: string
  queryStringParameters: QueryStringParameters | null 
}

export type EventBody = {
  request: EventRequest
  received_timestamp: Number
  sqs_publish_result?: SQSPublishResult  
}

/**
 * @jest-environment node
 */

import { strict as assert } from "assert"

import axios from "axios"
import { AxiosRequestConfig, AxiosResponse, AxiosError } from "axios"
import { URL } from "url"
import { readFileSync } from "fs"
import {
  DynamoDBClient,
  GetItemCommand,
  GetItemCommandOutput,
  AttributeValue,
} from "@aws-sdk/client-dynamodb"
const retry = require("async-retry")
jest.setTimeout(30000)

type ReturnType = { status_code?: number; db_entry?: any; message_id?: string }
type CDK_Outputs = {
  AWSREGION: string
  DynamoDBTable: string
  SolidusBufferedEndpoint: string
  UsesFauxBackend?: string
}
type DBEntry = { [key: string]: AttributeValue }

async function auto_retry_get_item(
  dbclient: DynamoDBClient,
  cmd: GetItemCommand,
  message_id: string,
  wait_for_result: boolean
): Promise<GetItemCommandOutput> {
  return await retry(
    async (bail: any, attempt: number) => {
      // if anything throws, we retry
      // console.log(`Attempt: ${attempt}`);
      const data: GetItemCommandOutput = await dbclient.send(cmd)
      if (data.Item === undefined)
        throw new Error(`No item found for message ID ${message_id}, retrying`)
      if (wait_for_result && data.Item.backend_response_status_code === undefined)
        throw new Error(
          `No data for response from backend found for message ID ${message_id}, retrying`
        )
      return data
    },
    {
      minTimeout: 300,
      retries: 10,
      randomize: false,
      factor: 1.2,
    }
  )
}

async function get_log_for_message_id({
  message_id,
  cdk_outputs,
  wait_for_result,
}: {
  message_id: string
  cdk_outputs: CDK_Outputs
  wait_for_result: boolean
}): Promise<DBEntry> {
  assert(cdk_outputs.AWSREGION)
  // NB: we create this new every time because if we are testing multiple envs the
  // region might change
  const dbclient = new DynamoDBClient({ region: cdk_outputs.AWSREGION })

  assert(cdk_outputs.DynamoDBTable)
  const params = {
    TableName: cdk_outputs.DynamoDBTable,
    Key: {
      id: { S: message_id },
    },
    // ProjectionExpression: 'ATTRIBUTE_NAME',
  }

  let cmd = new GetItemCommand(params)
  const data: GetItemCommandOutput = await auto_retry_get_item(
    dbclient,
    cmd,
    message_id,
    wait_for_result
  )
  // console.log('Success', data.Item);
  if (data.Item === undefined) throw new Error(`Entry never appeared in the database`)
  return data.Item
}

async function foo(
  cdk_outputs: CDK_Outputs,
  axios_config: AxiosRequestConfig
): Promise<ReturnType> {
  let endpoint = cdk_outputs["SolidusBufferedEndpoint"]

  let result: ReturnType = {}

  // Stage 1: Call the buffered endpoint
  let axios_result: AxiosResponse | null = null
  const url = new URL("health", endpoint).toString()
  let request_config: AxiosRequestConfig = Object.assign({ url }, axios_config)

  try {
    axios_result = await axios(request_config)
  } catch (error) {
    let foo: AxiosError = error
    result.status_code = foo.response?.status
    return result
  }

  result.status_code = axios_result?.status
  if (axios_result?.status != 200) return result

  let message_id: string | null = axios_result?.data.message_id
  assert(message_id)
  result.message_id = message_id
  return result
}

async function get_log_from_db(
  cdk_outputs: CDK_Outputs,
  message_id: string,
  wait_for_result: boolean = false
): Promise<ReturnType> {
  // Stage 2: Retrieve the logs from the database for the request
  // Now here we have a bit of an issue because the request will take time to
  // propogate through the lambdas and into the DB. We need a retry and timeout
  // strategy
  // wait_for_result will mean we also wait for the response from the backend call to
  // appear in the database
  let result: ReturnType = {}
  let item = await get_log_for_message_id({ message_id, cdk_outputs, wait_for_result })
  result.db_entry = item
  return result
}

async function main() {
  let cdk_outputs: { [key: string]: CDK_Outputs } = JSON.parse(
    readFileSync("./cdk.out.json").toString()
  )
  let stacks = Object.keys(cdk_outputs)
  console.log(`Stacks found: ${stacks.join(", ")}`)
  let env: string | undefined = process.env.npm_config_env
  if (env) {
    stacks = stacks.filter((stack_name) => stack_name.endsWith(env as string))
  }
  console.log(`Testing ${env ? env : "all"} stacks: ${stacks.join(", ")}`)

  for (let index = 0; index < stacks.length; index++) {
    const stack_name = stacks[index]
    console.log(`Testing stack ${stack_name}`)
    await test_stack(cdk_outputs[stack_name])
  }
}

main()

let minimum_valid_body: (extra: any) => string = (extra) =>
  JSON.stringify(
    Object.assign({ order_id: "123456", suppress_sentry: true, consume_bad_messages: true }, extra)
  )

async function test_stack(cdk_outputs: CDK_Outputs) {
  // GETs are not supported as the OMS specification is order_id is always present in the body,
  // PUTs are not supported because the heathcheck endpoint doesn't accept them

  /***
   * Happy Path Tests
   */
  test("200 for a basic POST", async () => {
    let result = await foo(cdk_outputs, {
      method: "POST",
      data: minimum_valid_body({}),
    })
    expect(result.status_code).toBe(200)
    expect(result.message_id).toBeDefined()
    assert(result.message_id)
    result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id))
    expect(result.db_entry?.message_id.S).toBe(result.message_id)
    /* Request to backend call is in  database */
    expect(result.db_entry?.request.S).toBeDefined()
    let request = JSON.parse(result.db_entry?.request.S)
    expect(request.path).toBe("/health")
    expect(request.body).toEqual(minimum_valid_body({}))
    expect(request.queryStringParameters).toBeNull()
    expect(request.httpMethod).toBe("POST")
    /* Response from backend call is in  database */
    // Need an extra wait to wait for backend_response to be in DB
    assert(result.message_id)
    result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id, true))
    expect(result.db_entry?.backend_response_status_code.N).toBe("200")
  })

  test("200 for a POST with query params", async () => {
    let params = { hello: "world" }
    let result = await foo(cdk_outputs, {
      method: "POST",
      data: minimum_valid_body({}),
      params,
    })
    expect(result.status_code).toBe(200)
    /* Request to backend call is in  database */
    assert(result.message_id)
    result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id))
    expect(result.db_entry?.message_id.S).toBe(result.message_id)
    expect(result.db_entry?.request.S).toBeDefined()
    let request = JSON.parse(result.db_entry?.request.S)
    expect(request.queryStringParameters).toEqual({ hello: "world" })
    /* Response from backend call is in  database */
    // Need an extra wait to wait for backend_response to be in DB
    assert(result.message_id)
    result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id, true))
    expect(result.db_entry?.backend_response_status_code.N).toBe("200")
  })

  test("200 for a POST with minimum_valid_body", async () => {
    let result = await foo(cdk_outputs, {
      method: "POST",
      data: minimum_valid_body({}),
    })
    expect(result.status_code).toBe(200)
    expect(result.message_id).toBeDefined()
    /* Request to backend call is in  database */
    assert(result.message_id)
    result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id))
    expect(result.db_entry?.message_id.S).toBe(result.message_id)
    expect(result.db_entry?.request.S).toBeDefined()
    let request = JSON.parse(result.db_entry?.request.S)
    expect(request.body).toEqual(minimum_valid_body({}))
    expect(request.httpMethod).toBe("POST")
    /* Response from backend call is in  database */
    // Need an extra wait to wait for backend_response to be in DB
    assert(result.message_id)
    result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id, true))
    expect(result.db_entry?.backend_response_status_code.N).toBe("200")
  })

  test("200 for PUT with a valid json body", async () => {
    let result = await foo(cdk_outputs, {
      method: "PUT",
      data: minimum_valid_body({}),
    })
    expect(result.status_code).toBe(200)
  })

  /***
   * Error Path Tests
   */

  test("400 for POST with a json body missing order_id", async () => {
    let result = await foo(cdk_outputs, {
      method: "POST",
      data: { this_should: "fail", suppress_sentry: true, consume_bad_messages: true },
    })
    expect(result.status_code).toBe(400)
  })

  // This fails when not consuming bad messages, perhaps because the retry blats over
  // the stored result
  test("404 stored in database for PUT with an invalid path", async () => {
    let endpoint = cdk_outputs["SolidusBufferedEndpoint"]
    const url = new URL("path_that_does_not_exist", endpoint).toString()
    let data = minimum_valid_body({ faux_backend_force_status_code: "404" })
    let result = await foo(cdk_outputs, {
      method: "PUT",
      data,
      url,
    })
    expect(result.status_code).toBe(200)
    expect(result.message_id).toBeDefined()
    /* Request to backend call is in  database */
    assert(result.message_id)
    result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id))
    expect(result.db_entry?.message_id.S).toBe(result.message_id)
    expect(result.db_entry?.request.S).toBeDefined()
    let request = JSON.parse(result.db_entry?.request.S)
    expect(request.body).toEqual(data)
    expect(request.httpMethod).toBe("PUT")
    /* Response from backend call is in  database */
    // Need an extra wait to wait for backend_response to be in DB
    assert(result.message_id)
    result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id, true))
    expect(result.db_entry?.backend_response_status_code.N).toBe("404")
  })

  if (process.env.npm_config_faux_backend || cdk_outputs.UsesFauxBackend) {
    test("401 is stored in database (requires faux backend to pass)", async () => {
      let result = await foo(cdk_outputs, {
        method: "POST",
        data: minimum_valid_body({ faux_backend_force_status_code: "401" }),
      })
      expect(result.status_code).toBe(200)
      expect(result.message_id).toBeDefined()
      /* Request to backend call is in  database */
      assert(result.message_id)
      result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id))
      expect(result.db_entry?.message_id.S).toBe(result.message_id)
      expect(result.db_entry?.request.S).toBeDefined()
      /* Response from backend call is in  database */
      // Need an extra wait to wait for backend_response to be in DB
      assert(result.message_id)
      result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id, true))
      expect(result.db_entry?.backend_response_status_code.N).toBe("401")
    })

    test("500 is stored in database (requires faux backend to pass)", async () => {
      let result = await foo(cdk_outputs, {
        method: "POST",
        data: minimum_valid_body({ faux_backend_force_status_code: "500" }),
      })
      expect(result.status_code).toBe(200)
      expect(result.message_id).toBeDefined()
      /* Request to backend call is in  database */
      assert(result.message_id)
      result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id))
      expect(result.db_entry?.message_id.S).toBe(result.message_id)
      expect(result.db_entry?.request.S).toBeDefined()
      /* Response from backend call is in  database */
      // Need an extra wait to wait for backend_response to be in DB
      assert(result.message_id)
      result = Object.assign(result, await get_log_from_db(cdk_outputs, result.message_id, true))
      expect(result.db_entry?.backend_response_status_code.N).toBe("500")
    })
  }
}

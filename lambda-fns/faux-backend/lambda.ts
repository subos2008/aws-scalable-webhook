import { APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda"

export const handler: APIGatewayProxyHandler = async function (
  event
): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({ request: event }, undefined, 2))

  let status_code = 200
  try {
    if (event.body) {
      let body = JSON.parse(event.body)
      if (body.faux_backend_force_status_code) {
        status_code = Number(body.faux_backend_force_status_code)
      }
    }
  } catch (e) {}
  let response = sendRes(status_code, JSON.stringify({ msg: "Event received" }))
  // return response back to upstream caller
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

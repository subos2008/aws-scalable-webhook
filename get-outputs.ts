#!./node_modules/.bin/ts-node

import { StackInspector } from "./lib/stack-inspector"

let env = process.argv[2]
console.error(`Downloading outputs for env: ${env}`)
if (!env) {
  console.error(`Pass env slug on command line, i.e. prd`)
}


let stack_name_prefix = "sqs-webhook-buffer-"
let region = "us-east-1"

import { CloudFormationClient } from "@aws-sdk/client-cloudformation"
const client = new CloudFormationClient({ region })

const inspector = new StackInspector({ client, stack_name_prefix })

async function main() {
  let stack_name = `${stack_name_prefix}${env}`
  let outputs_obj = await inspector.get_stack_outputs_object(stack_name)
  console.log(JSON.stringify({[stack_name]: outputs_obj}))
}

main()

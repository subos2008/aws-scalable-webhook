import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStacksCommandOutput,
  ListStacksCommand,
  Output,
  Stack,
  StackStatus,
  StackSummary,
} from "@aws-sdk/client-cloudformation"
import { threadId } from "node:worker_threads"

export class StackInspector {
  client: CloudFormationClient
  stack_name_prefix: string
  debug:boolean

  constructor({
    client,
    stack_name_prefix,
    debug
  }: {
    client: CloudFormationClient
    stack_name_prefix: string
    debug?:boolean
  }) {
    this.client = client
    this.stack_name_prefix = stack_name_prefix
    this.debug = debug || false
  }

  async list_stacks(): Promise<StackSummary[]> {
    const command = new ListStacksCommand({
      StackStatusFilter: [StackStatus.CREATE_COMPLETE, StackStatus.UPDATE_COMPLETE],
    })
    const response = await this.client.send(command)
    if(this.debug) console.log(response)

    if (response.NextToken) throw new Error(`Paging not implemented and may be required`)
    if (!response.StackSummaries) return []
    let stacks = response.StackSummaries.filter((stack) =>
      stack.StackName?.startsWith(this.stack_name_prefix)
    )
    return stacks
  }

  async get_stack(stack_name: string): Promise<StackSummary> {
    if (!stack_name.startsWith(this.stack_name_prefix)) {
      throw new Error(
        `Requested stack name ${stack_name} does not start with prefix ${this.stack_name_prefix}`
      )
    }
    const stacks = await this.list_stacks()
    let stack = stacks.find((stack) => stack.StackName === stack_name)
    if(this.debug) console.log(stack)

    if (!stack) {
      console.error(`Stack ${stack_name} not found`)
      process.exit(1)
    }
    return stack
  }

  async describe_stack(stack_summary: StackSummary): Promise<Stack> {
    let StackName = stack_summary.StackId
    const command = new DescribeStacksCommand({ StackName })
    const response: DescribeStacksCommandOutput = await this.client.send(command)
    let stacks = response?.Stacks
    if(this.debug) console.log(stacks)

    if (!stacks || !stacks[0]) {
      console.error(`Stack ${StackName} not found`)
      process.exit(1)
    }
    return stacks[0]
  }

  async get_stack_outputs_object(
    stack_name: string
  ): Promise<{ [key: string]: string | undefined }> {
    let stack_summary = await this.get_stack(stack_name)
    let stack = await this.describe_stack(stack_summary)
    if(this.debug) console.log(stack)
    if (!stack.Outputs) {
      return {}
    }
    return stack.Outputs.reduce(
      (obj, cur: Output) => ({ ...obj, [cur.OutputKey || "oops"]: cur.OutputValue }),
      {}
    )
  }
}

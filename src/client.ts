import "dotenv/config"
// import { createGoogleGenerativeAI } from "@ai-sdk/google"
import OpenAI from "openai";
import confirm from "@inquirer/confirm"
import input from "@inquirer/input"
import select from "@inquirer/select"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  CreateMessageRequestSchema,
  Prompt,
  PromptMessage,
  Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { generateText, jsonSchema, ToolSet } from "ai"

const mcp = new Client(
  {
    name: "text-client-video",
    version: "1.0.0",
  },
  { capabilities: { sampling: {} } }
)

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/server.js"],
  stderr: "ignore",
})

// const google = createGoogleGenerativeAI({
//   apiKey: process.env.GEMINI_API_KEY,
// })

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  await mcp.connect(transport)
  const [{ tools }, { prompts }, { resources }, { resourceTemplates }] =
    await Promise.all([
      mcp.listTools(),
      mcp.listPrompts(),
      mcp.listResources(),
      mcp.listResourceTemplates(),
    ])

  mcp.setRequestHandler(CreateMessageRequestSchema, async request => {
    const texts: string[] = []
    for (const message of request.params.messages) {
      const text = await handleServerMessagePrompt(message)
      if (text != null) texts.push(text)
    }

    return {
      role: "user",
      model: "gemini-2.0-flash",
      stopReason: "endTurn",
      content: {
        type: "text",
        text: texts.join("\n"),
      },
    }
  })

  console.log("You are connected!")
  while (true) {
    const option = await select({
      message: "What would you like to do",
      choices: ["Query", "Tools", "Resources", "Prompts"],
    })

    switch (option) {
      case "Tools":
        const toolName = await select({
          message: "Select a tool",
          choices: tools.map(tool => ({
            name: tool.annotations?.title || tool.name,
            value: tool.name,
            description: tool.description,
          })),
        })
        const tool = tools.find(t => t.name === toolName)
        if (tool == null) {
          console.error("Tool not found.")
        } else {
          await handleTool(tool)
        }
        break
      case "Resources":
        const resourceUri = await select({
          message: "Select a resource",
          choices: [
            ...resources.map(resource => ({
              name: resource.name,
              value: resource.uri,
              description: resource.description,
            })),
            ...resourceTemplates.map(template => ({
              name: template.name,
              value: template.uriTemplate,
              description: template.description,
            })),
          ],
        })
        const uri =
          resources.find(r => r.uri === resourceUri)?.uri ??
          resourceTemplates.find(r => r.uriTemplate === resourceUri)
            ?.uriTemplate
        if (uri == null) {
          console.error("Resource not found.")
        } else {
          await handleResource(uri)
        }
        break
      case "Prompts":
        const promptName = await select({
          message: "Select a prompt",
          choices: prompts.map(prompt => ({
            name: prompt.name,
            value: prompt.name,
            description: prompt.description,
          })),
        })
        const prompt = prompts.find(p => p.name === promptName)
        if (prompt == null) {
          console.error("Prompt not found.")
        } else {
          await handlePrompt(prompt)
        }
        break
      case "Query":
        await handleQuery(tools)
    }
  }
}

function toOpenAISchema(vercelSchema: any) {
  const schema = vercelSchema?.inputSchema ?? vercelSchema;
  if (!schema || schema.type === "None") {
    return {
      type: "object",
      properties: {},
      required: [],
    };
  }

  if (schema.type !== "object") {
    throw new Error("OpenAI function parameters must be type: object");
  }

  return {
    type: schema.type,
    properties: schema.properties || {},
    required: schema.required || [],
  };
}


async function handleQuery(tools: Tool[]) {
  const query = await input({ message: "Enter your query" })

  // const { text, toolResults } = await generateText({
  //   model: google("gemini-2.0-flash"),
  //   prompt: query,
  //   tools: tools.reduce(
  //     (obj, tool) => ({
  //       ...obj,
  //       [tool.name]: {
  //         description: tool.description,
  //         parameters: jsonSchema(tool.inputSchema),
  //         execute: async (args: Record<string, any>) => {
  //           return await mcp.callTool({
  //             name: tool.name,
  //             arguments: args,
  //           })
  //         },
  //       },
  //     }),
  //     {} as ToolSet
  //   ),
  // })

  // console.log(
  //   // @ts-expect-error
  //   text || toolResults[0]?.result?.content[0]?.text || "No text generated."
  // )

  const openAiFunctions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toOpenAISchema(tool)
  }));

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "user", content: query }
    ],
    functions: openAiFunctions,
    function_call: "auto",
  });

  console.log('response:', JSON.stringify(response));

  const message: any = response.choices[0].message;

  let finalText = message.content;

  // Support both legacy `tool_calls` and OpenAI `function_call`
  const calls = message.tool_calls ?? (message.function_call ? [message.function_call] : [])

  if (calls.length) {
    for (const call of calls) {
      const functionName = call.function?.name ?? call.name
      const functionArgsString = call.function?.arguments ?? call.arguments ?? "{}"
      const functionArgs = functionArgsString ? JSON.parse(functionArgsString) : {}

      const result = await mcp.callTool({
        name: functionName,
        arguments: functionArgs,
      })

      // Send function/tool result back to OpenAI as a `function` message
      const followUp = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "user", content: query },
          message,
          {
            role: "function",
            name: functionName,
            content: JSON.stringify(result),
          },
        ],
      })

      finalText = followUp.choices[0].message.content
    }
  }

  console.log(finalText || "No text generated.");

}

async function handleTool(tool: Tool) {
  const args: Record<string, string> = {}
  for (const [key, value] of Object.entries(
    tool.inputSchema.properties ?? {}
  )) {
    args[key] = await input({
      message: `Enter value for ${key} (${(value as { type: string }).type}):`,
    })
  }

  const res = await mcp.callTool({
    name: tool.name,
    arguments: args,
  })

  console.log((res.content as [{ text: string }])[0].text)
}

async function handleResource(uri: string) {
  let finalUri = uri
  const paramMatches = uri.match(/{([^}]+)}/g)

  if (paramMatches != null) {
    for (const paramMatch of paramMatches) {
      const paramName = paramMatch.replace("{", "").replace("}", "")
      const paramValue = await input({
        message: `Enter value for ${paramName}:`,
      })
      finalUri = finalUri.replace(paramMatch, paramValue)
    }
  }

  const res = await mcp.readResource({
    uri: finalUri,
  })

  console.log(
    JSON.stringify(JSON.parse(res.contents[0].text as string), null, 2)
  )
}

async function handlePrompt(prompt: Prompt) {
  const args: Record<string, string> = {}
  for (const arg of prompt.arguments ?? []) {
    args[arg.name] = await input({
      message: `Enter value for ${arg.name}:`,
    })
  }

  const response = await mcp.getPrompt({
    name: prompt.name,
    arguments: args,
  })

  for (const message of response.messages) {
    console.log(await handleServerMessagePrompt(message))
  }
}

async function handleServerMessagePrompt(message: PromptMessage) {
  if (message.content.type !== "text") return

  console.log(message.content.text)
  const run = await confirm({
    message: "Would you like to run the above prompt",
    default: true,
  })

  if (!run) return

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "user", content: message.content.text }
    ],
  });

  const text = completion.choices[0].message.content;

  return text
}

main()

#!/usr/bin/env node
import 'dotenv/config'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import {
  GoogleGenerativeAI,
  FunctionDeclaration,
  SchemaType,
} from '@google/generative-ai'

/* =====================================================
 * Types
 * ===================================================== */

interface MCPTool {
  name: string
  description?: string
  inputSchema?: unknown
}

interface MCPRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: any
}

interface MCPResponse {
  jsonrpc: '2.0'
  id: number
  result?: any
  error?: any
}

/* =====================================================
 * MCP Client
 * ===================================================== */

class MCPClient {
  private child
  private buffer = ''
  private id = 0
  private pending = new Map<number, (res: MCPResponse) => void>()

  private genAI
  private model
  private tools: FunctionDeclaration[] = []

  constructor(serverPath: string) {
    /* ---- Start MCP Server ---- */
    this.child = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    this.child.stdout.on('data', (data) => this.onData(data.toString()))

    /* ---- Gemini ---- */
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not set')
    }

    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    this.model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
    })
  }

  /* =================================================== */

  private onData(chunk: string) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      const msg = JSON.parse(line) as MCPResponse
      const resolver = this.pending.get(msg.id)
      if (resolver) {
        resolver(msg)
        this.pending.delete(msg.id)
      }
    }
  }

  private request(method: string, params?: any): Promise<MCPResponse> {
    const id = ++this.id
    const payload: MCPRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.child.stdin.write(JSON.stringify(payload) + '\n')
    })
  }

  /* =================================================== */

  async init() {
    const res = await this.request('tools/list')

    const tools: MCPTool[] = res.result.tools

    console.log(
      'Connected to server with tools:',
      tools.map((t) => t.name)
    )

    this.tools = tools.map((tool) => this.toGeminiTool(tool))
  }

  /* ===================================================
   * MCP → Gemini Schema Adapter (SAFE)
   * =================================================== */

  private toGeminiTool(tool: MCPTool): FunctionDeclaration {
    switch (tool.name) {
      case 'get_forecast':
        return {
          name: 'get_forecast',
          description: 'Get weather forecast for a city',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              city: {
                type: SchemaType.STRING,
              },
            },
            required: ['city'],
          },
        }

      case 'get_alerts':
        return {
          name: 'get_alerts',
          description: 'Get weather alerts for a region',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              region: {
                type: SchemaType.STRING,
              },
            },
            required: ['region'],
          },
        }

      default:
        return {
          name: tool.name,
          description: tool.description ?? '',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {},
          },
        }
    }
  }

  /* =================================================== */

  async processQuery(query: string) {
    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: query }] }],
      tools: [{ functionDeclarations: this.tools }],
    })

    const call =
      result.response.candidates?.[0]?.content?.parts?.find(
        (p: any) => p.functionCall
      )?.functionCall

    if (!call) {
      console.log('\n🤖', result.response.text())
      return
    }

    const toolResult = await this.request('tools/call', {
      name: call.name,
      arguments: call.args,
    })

    const followUp = await this.model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: query }] },
        {
          role: 'tool',
          parts: [
            {
              functionResponse: {
                name: call.name,
                response: toolResult.result,
              },
            },
          ],
        },
      ],
    })

    console.log('\n🌤️', followUp.response.text())
  }

  /* =================================================== */

  async chatLoop() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    console.log('\nMCP Client Started (Gemini)!\nType your queries or "quit".\n')

    for await (const line of rl) {
      if (line.trim().toLowerCase() === 'quit') {
        rl.close()
        process.exit(0)
      }
      await this.processQuery(line)
    }
  }
}

/* =====================================================
 * Main
 * ===================================================== */

async function main() {
  const serverPath = process.argv[2]
  if (!serverPath) {
    console.error('Usage: node index.js <mcp-server.js>')
    process.exit(1)
  }

  const client = new MCPClient(serverPath)
  await client.init()
  await client.chatLoop()
}

main()

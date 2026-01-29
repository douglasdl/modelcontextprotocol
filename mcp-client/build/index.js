import { GoogleGenerativeAI } from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
dotenv.config();
// =====================
// ENV
// =====================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
}
const GEMINI_MODEL = "gemini-1.5-pro";
// =====================
// MCP Client
// =====================
class MCPClient {
    mcp;
    gemini;
    transport = null;
    tools = [];
    constructor() {
        this.gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
        this.mcp = new Client({
            name: "mcp-client-cli",
            version: "1.0.0",
        });
    }
    async connectToServer(serverScriptPath) {
        try {
            const isJs = serverScriptPath.endsWith(".js");
            const isPy = serverScriptPath.endsWith(".py");
            if (!isJs && !isPy) {
                throw new Error("Server script must be a .js or .py file");
            }
            const command = isPy
                ? process.platform === "win32"
                    ? "python"
                    : "python3"
                : process.execPath;
            this.transport = new StdioClientTransport({
                command,
                args: [serverScriptPath],
            });
            await this.mcp.connect(this.transport);
            const toolsResult = await this.mcp.listTools();
            // Convert MCP tools → Gemini function declarations
            this.tools = toolsResult.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            }));
            console.log("Connected to server with tools:", this.tools.map((t) => t.name));
        }
        catch (e) {
            console.error("Failed to connect to MCP server:", e);
            throw e;
        }
    }
    async processQuery(query) {
        const model = this.gemini.getGenerativeModel({
            model: GEMINI_MODEL,
            tools: [
                {
                    functionDeclarations: this.tools,
                },
            ],
        });
        let messages = [
            {
                role: "user",
                parts: [{ text: query }],
            },
        ];
        const finalText = [];
        // First call
        let result = await model.generateContent({
            contents: messages,
        });
        let response = result.response;
        while (true) {
            const candidate = response.candidates?.[0];
            const part = candidate?.content?.parts?.[0];
            // Normal text response
            if (part?.text) {
                finalText.push(part.text);
                break;
            }
            // Tool call (functionCall)
            if (part?.functionCall) {
                const { name, args } = part.functionCall;
                const toolResult = await this.mcp.callTool({
                    name,
                    arguments: args,
                });
                // Feed tool result back to Gemini
                messages.push({
                    role: "model",
                    parts: [
                        {
                            functionResponse: {
                                name,
                                response: {
                                    content: toolResult.content,
                                },
                            },
                        },
                    ],
                });
                result = await model.generateContent({
                    contents: messages,
                });
                response = result.response;
                continue;
            }
            // Fallback
            finalText.push("No response from Gemini.");
            break;
        }
        return finalText.join("\n");
    }
    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        try {
            console.log("\nMCP Client Started (Gemini)!");
            console.log("Type your queries or 'quit' to exit.");
            while (true) {
                const message = await rl.question("\nQuery: ");
                if (message.toLowerCase() === "quit")
                    break;
                const response = await this.processQuery(message);
                console.log("\n" + response);
            }
        }
        finally {
            rl.close();
        }
    }
    async cleanup() {
        await this.mcp.close();
    }
}
// =====================
// Main
// =====================
async function main() {
    if (process.argv.length < 3) {
        console.log("Usage: node build/index.js <path_to_server_script>");
        return;
    }
    const mcpClient = new MCPClient();
    try {
        await mcpClient.connectToServer(process.argv[2]);
        await mcpClient.chatLoop();
    }
    catch (e) {
        console.error("Error:", e);
        await mcpClient.cleanup();
        process.exit(1);
    }
    finally {
        await mcpClient.cleanup();
        process.exit(0);
    }
}
main();

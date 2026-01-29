import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
dotenv.config();
// =====================
// ENV
// =====================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
}
const OPENAI_MODEL = "gpt-4o-mini";
// =====================
// MCP Client
// =====================
class MCPClient {
    mcp;
    openai;
    transport = null;
    tools = [];
    constructor() {
        this.openai = new OpenAI({
            apiKey: OPENAI_API_KEY,
        });
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
            this.tools = toolsResult.tools.map((tool) => ({
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                },
            }));
            console.log("Connected to server with tools:", this.tools.map((t) => t.function.name));
        }
        catch (e) {
            console.error("Failed to connect to MCP server:", e);
            throw e;
        }
    }
    async processQuery(query) {
        const messages = [
            {
                role: "user",
                content: query,
            },
        ];
        const response = await this.openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages,
            tools: this.tools,
            tool_choice: "auto",
        });
        const finalText = [];
        const message = response.choices[0].message;
        if (message.content) {
            finalText.push(message.content);
        }
        if (message.tool_calls) {
            for (const toolCall of message.tool_calls) {
                if (toolCall.type !== "function")
                    continue;
                const toolName = toolCall.function.name;
                const toolArgs = JSON.parse(toolCall.function.arguments || "{}");
                const result = await this.mcp.callTool({
                    name: toolName,
                    arguments: toolArgs,
                });
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result.content,
                });
            }
            const followUp = await this.openai.chat.completions.create({
                model: OPENAI_MODEL,
                messages,
            });
            if (followUp.choices[0].message.content) {
                finalText.push(followUp.choices[0].message.content);
            }
        }
        return finalText.join("\n");
    }
    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        try {
            console.log("\nMCP Client Started!");
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

import { createServer } from "node:http"

/** The native prompt prefix that identifies a subagent child request. */
export const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
/** The OpenAI-compatible request carries the model id without its provider prefix. */
export const PARENT_MODEL = "parent"
export const CHILD_MARKER_FILE = "cwd-marker.txt"

const text = (content) =>
  Array.isArray(content)
    ? content.map((part) => String(part?.text ?? "")).join("")
    : String(content ?? "")

/**
 * Scripted OpenAI-compatible endpoint: the parent asks for the `subagent` tool, the child
 * reads a destination-relative file, and neither needs a real model. Every request body is
 * kept so the caller can assert on the child's **first** request.
 */
export async function createLocalModel() {
  const requests = []
  let invocation

  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      response.writeHead(400).end("invalid json")
      return
    }

    const messages = Array.isArray(body.messages) ? body.messages : []
    const child = messages.some(
      (message) => message.role === "user" && text(message.content).includes(SUBAGENT_PROMPT),
    )
    const parent = !child && body.model === PARENT_MODEL && invocation !== undefined
    const toolResults = messages.filter((message) => message.role === "tool").length
    requests.push({ model: body.model, child, parent, body })

    let message
    let finish = "stop"
    if (parent && toolResults === 0) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_subagent_${requests.length}`,
            type: "function",
            function: { name: "subagent", arguments: JSON.stringify(invocation) },
          },
        ],
      }
      finish = "tool_calls"
    } else if (child && toolResults === 0) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: CHILD_MARKER_FILE }) },
          },
        ],
      }
      finish = "tool_calls"
    } else {
      message = { role: "assistant", content: child ? "CHILD_OK" : "DONE" }
    }

    const base = { id: "c9", created: 1, model: body.model }
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }] }),
      )
      return
    }

    response.writeHead(200, { "content-type": "text/event-stream" })
    const delta =
      finish === "tool_calls"
        ? { ...message, tool_calls: message.tool_calls.map((call) => ({ index: 0, ...call })) }
        : message
    for (const [part, reason] of [
      [delta, null],
      [{}, finish],
    ]) {
      response.write(
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`,
      )
    }
    response.end("data: [DONE]\n\n")
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    arm(next) {
      invocation = next
      return requests.length
    },
    of(mark) {
      return requests.slice(mark)
    },
    close() {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

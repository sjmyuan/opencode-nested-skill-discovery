import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { dirname } from "node:path"

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("no port")))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

export function authHeader(password) {
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
}

const LISTENING = /^server listening on (http:\/\/127\.0\.0\.1:(\d+))$/m
const PASSWORD = /^server password (.+)$/m

export async function startServe({ cwd, env, logFile, timeoutMs = 30_000 }) {
  const port = await freePort()
  mkdirSync(dirname(logFile), { recursive: true })
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let buffer = ""
  const tee = (chunk) => {
    buffer += chunk
    appendFileSync(logFile, chunk)
  }
  child.stdout.setEncoding("utf8").on("data", tee)
  child.stderr.setEncoding("utf8").on("data", tee)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const listening = buffer.match(LISTENING)
    const password = buffer.match(PASSWORD)
    if (listening !== null && password !== null) {
      const bound = Number(listening[2])
      if (bound !== port) throw new Error(`serve bound ${bound}, requested ${port}`)
      return {
        pid: child.pid,
        port,
        base: listening[1],
        password: password[1].trim(),
        logFile,
        stop: () => stopServe(child),
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`serve exited ${child.exitCode} before listening\n${tail(buffer)}`)
    }
    await delay(100)
  }
  await stopServe(child)
  throw new Error(`serve did not become ready in ${timeoutMs} ms\n${tail(buffer)}`)
}

function tail(buffer) {
  return buffer.split("\n").slice(-40).join("\n")
}

export async function stopServe(child) {
  if (child.exitCode !== null) return child.exitCode
  child.kill("SIGTERM")
  const exited = await waitForExit(child, 5_000)
  if (!exited) {
    child.kill("SIGKILL")
    await waitForExit(child, 2_000)
  }
  return child.exitCode
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export async function api(base, password, path, options = {}) {
  const url = new URL(path, base)
  if (options.location !== undefined) url.searchParams.set("location[directory]", options.location)
  const method = options.method ?? "GET"
  const response = await fetch(url, {
    method,
    headers: { ...authHeader(password), ...(options.headers ?? {}) },
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 400)}`)
  return text === "" ? undefined : JSON.parse(text)
}

export async function reload(base, password) {
  const response = await fetch(new URL("/api/location/reload", base), {
    method: "POST",
    headers: authHeader(password),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`POST /api/location/reload -> HTTP ${response.status}`)
  return response.status
}

export async function poll(fn, { until, timeoutMs, intervalMs, onAttempt }) {
  const started = Date.now()
  let attempts = 0
  let value
  let lastError
  while (Date.now() - started <= timeoutMs) {
    attempts += 1
    try {
      value = await fn(attempts)
      lastError = undefined
    } catch (error) {
      lastError = error
      value = undefined
    }
    if (onAttempt !== undefined) onAttempt({ at: new Date().toISOString(), attempts, value, error: lastError?.message })
    if (lastError === undefined && until(value)) {
      return { ok: true, value, attempts, elapsedMs: Date.now() - started }
    }
    await delay(intervalMs)
  }
  return { ok: false, value, attempts, elapsedMs: Date.now() - started, error: lastError?.message }
}

export async function pollStable(fn, { timeoutMs, intervalMs, stableFor = 3, signature, ready }) {
  const started = Date.now()
  let attempts = 0
  let previous
  let same = 0
  let value
  while (Date.now() - started <= timeoutMs) {
    attempts += 1
    try {
      value = await fn(attempts)
    } catch {
      value = undefined
    }
    if (value === undefined || (ready !== undefined && !ready(value))) {
      previous = undefined
      same = 0
      await delay(intervalMs)
      continue
    }
    const current = signature(value)
    if (current === previous) same += 1
    else {
      same = 1
      previous = current
    }
    if (same >= stableFor) return { ok: true, value, attempts, elapsedMs: Date.now() - started }
    await delay(intervalMs)
  }
  return { ok: false, value, attempts, elapsedMs: Date.now() - started }
}

export function removeTree(path) {
  rmSync(path, { recursive: true, force: true })
  return !existsSync(path)
}

export function redact(text, password) {
  const lines = text.split("\n").map((line) =>
    line.startsWith("server password ") ? "server password <redacted>" : line,
  )
  return lines.join("\n").replaceAll(password, "<redacted>")
}

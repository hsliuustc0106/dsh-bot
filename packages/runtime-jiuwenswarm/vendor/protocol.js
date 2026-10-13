// Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
export class ProtocolError extends Error {
}
const decoder = new TextDecoder("utf-8", { fatal: true });
export function encode(value) {
    const text = JSON.stringify(value, (_key, item) => {
        if (typeof item === "number" && !Number.isFinite(item))
            throw new TypeError("non-finite input number");
        return item;
    });
    const buffer = Buffer.from(text + "\n", "utf8");
    if (buffer.length > 1024 * 1024)
        throw new RangeError("input record exceeds 1 MiB");
    return buffer;
}
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decode(line) {
    const text = decoder.decode(line);
    const value = JSON.parse(text, (_key, item) => {
        if (typeof item === "number" && !Number.isFinite(item))
            throw new ProtocolError("non-finite output number");
        return item;
    });
    // Syntax is already validated. Structural tokens detect duplicate keys,
    // including escaped spellings, without reimplementing the JSON grammar.
    const stack = [];
    let lastString = "";
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:]/g)) {
        const token = match[0];
        if (token === "{")
            stack.push(new Set());
        else if (token === "[")
            stack.push(null);
        else if (token === "}" || token === "]")
            stack.pop();
        else if (token === ":") {
            const keys = stack.at(-1);
            if (keys?.has(lastString))
                throw new ProtocolError("duplicate output key");
            keys?.add(lastString);
        }
        else
            lastString = JSON.parse(token);
    }
    return value;
}
export class Records {
    requestId;
    operation;
    sequence = 0;
    sessionId = null;
    result;
    constructor(requestId, operation) {
        this.requestId = requestId;
        this.operation = operation;
    }
    accept(line) {
        if (this.result)
            throw new ProtocolError("output after terminal result");
        if (line.at(-1) !== 10)
            throw new ProtocolError("truncated JSONL record");
        let value;
        try {
            value = decode(line);
        }
        catch {
            throw new ProtocolError("invalid UTF-8 JSON record");
        }
        if (!object(value))
            throw new ProtocolError("output record must be an object");
        if (value.schema_version !== "0.1" || value.request_id !== this.requestId)
            throw new ProtocolError("output version/request identity mismatch");
        if (!Number.isSafeInteger(value.sequence) ||
            value.sequence !== this.sequence++)
            throw new ProtocolError("non-contiguous output sequence");
        const session = value.session_id;
        if (session !== null) {
            if (typeof session !== "string" || !session.trim())
                throw new ProtocolError("invalid Session identity");
            if (this.sessionId !== null && this.sessionId !== session)
                throw new ProtocolError("Session identity changed");
            this.sessionId = session;
        }
        if (value.type === "event" && this.operation === undefined) {
            if (typeof value.event_type !== "string" || !value.event_type)
                throw new ProtocolError("invalid event type");
            return value;
        }
        const expected = this.operation === undefined ? "result" : "query_result";
        if (value.type !== expected || session !== this.sessionId)
            throw new ProtocolError("invalid terminal record");
        if (this.operation !== undefined) {
            if (session !== null || this.sequence !== 1)
                throw new ProtocolError("query must not emit Session events");
            if (value.operation !== null && value.operation !== this.operation)
                throw new ProtocolError("query operation mismatch");
        }
        this.validateTerminal(value);
        this.result = value;
        return this.result;
    }
    validateTerminal(value) {
        const code = value.exit_code;
        const statuses = {
            0: "completed",
            1: "failed",
            2: "failed",
            124: "timed_out",
            130: "cancelled",
        };
        if (typeof code !== "number" ||
            !Number.isSafeInteger(code) ||
            !(code in statuses))
            throw new ProtocolError("invalid exit code");
        if (value.status !== statuses[code])
            throw new ProtocolError("inconsistent result status/exit code");
        if (code !== 0) {
            if (!object(value.error) || typeof value.error.code !== "string")
                throw new ProtocolError("failed result requires structured error");
        }
        else if (value.error !== null)
            throw new ProtocolError("successful result contains error");
        else if (this.operation !== undefined) {
            if (value.operation !== this.operation || !object(value.data))
                throw new ProtocolError("successful query requires data and operation");
        }
        else if (this.sessionId === null)
            throw new ProtocolError("successful run requires Session identity");
        if (this.operation === undefined &&
            value.output_json !== null &&
            value.output_json !== undefined &&
            !object(value.output_json))
            throw new ProtocolError("output_json must be an object or null");
    }
    finish(code) {
        if (!this.result)
            throw new ProtocolError("process exited without a terminal result");
        if (code !== this.result.exit_code)
            throw new ProtocolError("terminal result does not match process exit code");
        return this.result;
    }
}

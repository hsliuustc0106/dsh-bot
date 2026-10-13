// Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { encode, Records, ProtocolError, } from "./protocol.js";
export * from "./protocol.js";
export class TransportError extends Error {
}
export class InteractionRequired extends Error {
}
function rejectUnattendedPermission(record) {
    const payload = record.payload;
    const interaction = payload && !Array.isArray(payload) && typeof payload === "object"
        ? payload.interaction : null;
    if (!interaction || Array.isArray(interaction) || typeof interaction !== "object" ||
        interaction.source !== "permission_interrupt" || !Array.isArray(interaction.questions) ||
        !interaction.questions.length)
        throw new InteractionRequired("host interaction handler required; no approval granted");
    for (const question of interaction.questions) {
        if (!question || Array.isArray(question) || typeof question !== "object" ||
            !Array.isArray(question.options) ||
            !question.options.some((option) => option && !Array.isArray(option) &&
                typeof option === "object" && option.value === "reject"))
            throw new InteractionRequired("permission card has no safe rejection option");
    }
    return interaction.questions.map(() => ({ selected_options: ["reject"] }));
}
export class Client {
    options;
    command;
    grace;
    maxRecordBytes;
    constructor(options = {}) {
        this.options = options;
        this.command = options.command ?? ["jiuwenswarm-process"];
        if (!Array.isArray(this.command) ||
            !this.command.length ||
            this.command.some((x) => typeof x !== "string" || !x))
            throw new TypeError("command must be a nonempty argv array, not a shell string");
        this.grace = options.shutdownGraceMs ?? 30000;
        this.maxRecordBytes = options.maxRecordBytes ?? 8 * 1024 * 1024;
        if (!Number.isFinite(this.grace) || this.grace <= 0)
            throw new RangeError("shutdown grace must be positive and finite");
        if (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1)
            throw new RangeError("maxRecordBytes must be positive");
    }
    async run(request, options = {}) {
        if (request.host_tools?.length && !options.onToolCall)
            throw new TypeError("host_tools require an onToolCall callback");
        return (await this.execute({ ...request }, undefined, options));
    }
    async query(operation, params = {}, options = {}) {
        return (await this.execute({
            operation,
            params,
            workspace: options.workspace,
            timeout_seconds: options.timeout_seconds,
        }, operation, { deadlineMs: options.deadlineMs }));
    }
    async execute(request, operation, options) {
        if (options.deadlineMs !== undefined &&
            (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0))
            throw new RangeError("host deadline must be positive and finite");
        const requestId = request.request_id ?? randomUUID();
        if (typeof requestId !== "string" || !requestId.trim())
            throw new TypeError("request_id must be a nonempty string");
        const normalizedId = requestId.trim();
        const input = encode({
            schema_version: "0.1",
            type: operation === undefined ? "run" : "query",
            ...request,
            request_id: normalizedId,
        });
        const args = operation === undefined ? ["--run-jsonl"] : ["--query-json", "-"];
        const child = spawn(this.command[0], [...this.command.slice(1), ...args], {
            cwd: this.options.cwd,
            env: this.options.env
                ? { ...process.env, ...this.options.env }
                : undefined,
            stdio: "pipe",
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
        });
        const invocation = new Invocation(child, new Records(normalizedId, operation), this.maxRecordBytes);
        let timer;
        const cancel = () => {
            void invocation.cancel();
        };
        options.signal?.addEventListener("abort", cancel, { once: true });
        try {
            const execute = async () => {
                // Initial input always precedes cancellation, including an already-aborted signal.
                await invocation.write(input);
                if (operation !== undefined)
                    child.stdin.end();
                if (options.signal?.aborted)
                    await invocation.cancel();
                await invocation.consume(options);
                await invocation.closed;
                if (invocation.startError)
                    throw new TransportError("could not launch the Process CLI");
                return invocation.records.finish(child.exitCode);
            };
            const deadline = new Promise((_resolve, reject) => {
                if (options.deadlineMs !== undefined)
                    timer = setTimeout(() => reject(new TransportError("host deadline exceeded")), options.deadlineMs);
            });
            return await Promise.race([execute(), deadline]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            options.signal?.removeEventListener("abort", cancel);
            await invocation.close(this.grace);
        }
    }
}
class Invocation {
    child;
    records;
    maxRecordBytes;
    closed;
    startError;
    ended = false;
    cancelSent = false;
    stopped = false;
    stderrTail = Buffer.alloc(0);
    output = new OutputQueue();
    cancelled;
    resolveCancelled;
    constructor(child, records, maxRecordBytes) {
        this.child = child;
        this.records = records;
        this.maxRecordBytes = maxRecordBytes;
        this.closed = new Promise((resolve) => child.once("close", () => {
            this.ended = true;
            resolve();
        }));
        this.cancelled = new Promise((resolve) => {
            this.resolveCancelled = resolve;
        });
        child.on("error", (error) => {
            this.startError = error;
        });
        // Handle pipe errors at the source; early input rejection must not crash the host.
        child.stdin.on("error", () => { });
        child.stdout.on("error", () => { });
        child.stderr.on("error", () => { });
        child.stderr.on("data", (chunk) => {
            this.stderrTail = Buffer.concat([this.stderrTail, chunk]).subarray(-65536);
        });
        void this.readOutput().then(() => this.output.finish(), (error) => this.output.finish(error));
    }
    async write(buffer) {
        if (this.child.stdin.destroyed || this.child.stdin.writableEnded)
            return;
        await new Promise((resolve) => this.child.stdin.write(buffer, () => resolve()));
    }
    async cancel() {
        if (this.cancelSent || this.records.result || this.ended)
            return;
        this.cancelSent = true;
        this.resolveCancelled();
        await this.write(encode({
            schema_version: "0.1",
            type: "cancel",
            request_id: this.records.requestId,
        }));
    }
    async consume(options) {
        while (true) {
            const record = await this.output.take();
            if (record === null)
                return;
            if (record.type === "event" && !this.stopped)
                await this.event(record, options);
        }
    }
    async readOutput() {
        let pending = Buffer.alloc(0);
        for await (const chunk of this.child.stdout.iterator({
            destroyOnReturn: false,
        })) {
            if (this.stopped)
                continue;
            pending = Buffer.concat([pending, chunk]);
            let end;
            while ((end = pending.indexOf(10)) !== -1) {
                if (end + 1 > this.maxRecordBytes)
                    throw new ProtocolError("output record exceeds configured byte limit");
                const line = pending.subarray(0, end + 1);
                pending = pending.subarray(end + 1);
                const record = this.records.accept(line);
                this.output.push(record);
            }
            if (pending.length > this.maxRecordBytes)
                throw new ProtocolError("output record exceeds configured byte limit");
        }
        if (this.stopped)
            return;
        if (pending.length)
            throw new ProtocolError("truncated JSONL record");
        if (!this.records.result)
            throw new ProtocolError("process output ended without a terminal result");
    }
    async event(record, options) {
        if (this.cancelSent || this.stopped)
            return;
        await Promise.race([
            Promise.resolve().then(() => options.onEvent?.(record)),
            this.cancelled,
        ]);
        if (record.event_type === "host_tool.requested" && !this.cancelSent && !this.stopped) {
            const payload = record.payload;
            if (!payload || Array.isArray(payload) || typeof payload !== "object" ||
                typeof payload.call_id !== "string")
                throw new ProtocolError("host tool request has no correlation identity");
            if (!options.onToolCall)
                throw new ProtocolError("host tool callback is missing");
            let response;
            try {
                const result = await Promise.race([
                    Promise.resolve().then(() => options.onToolCall(record)),
                    this.cancelled,
                ]);
                response = { result: (result === undefined ? null : result) };
            }
            catch {
                response = { error: "Host tool callback failed." };
            }
            if (!this.cancelSent && !this.stopped)
                await this.write(encode({
                    schema_version: "0.1", type: "tool_result",
                    request_id: this.records.requestId,
                    session_id: record.session_id, call_id: payload.call_id,
                    ...response,
                }));
        }
        if (record.event_type !== "interaction.requested" ||
            this.cancelSent ||
            this.stopped)
            return;
        const answers = options.onInteraction
            ? await Promise.race([
                Promise.resolve().then(() => options.onInteraction(record)),
                this.cancelled,
            ])
            : rejectUnattendedPermission(record);
        if (this.cancelSent || this.stopped)
            return;
        const payload = record.payload;
        if (!payload ||
            Array.isArray(payload) ||
            typeof payload !== "object" ||
            typeof payload.interaction_id !== "string")
            throw new ProtocolError("interaction has no correlation identity");
        await this.write(encode({
            schema_version: "0.1",
            type: "answer",
            request_id: this.records.requestId,
            session_id: record.session_id,
            interaction_id: payload.interaction_id,
            answers,
        }));
    }
    async close(grace) {
        if (this.ended)
            return;
        this.stopped = true;
        this.resolveCancelled();
        // The reader is independent of host callbacks. Resume also handles a
        // reader that stopped after a protocol/size error.
        this.child.stdout.resume();
        let timer;
        const cleanup = async () => {
            if (this.records.operation === undefined)
                await this.cancel();
            else if (process.platform !== "win32")
                this.child.kill("SIGTERM");
            this.child.stdin.end();
            await this.closed;
            return true;
        };
        try {
            const finished = await Promise.race([
                cleanup(),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(false), grace);
                }),
            ]);
            if (!finished) {
                await this.forceStop();
                this.child.stdout.destroy();
                this.child.stderr.destroy();
                await this.closed;
            }
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    async forceStop() {
        const pid = this.child.pid;
        if (!pid || this.child.exitCode !== null || this.child.signalCode !== null)
            return;
        if (process.platform === "win32") {
            await new Promise((resolve) => {
                const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false });
                const timer = setTimeout(() => {
                    killer.kill();
                    resolve();
                }, 5000);
                const done = () => {
                    clearTimeout(timer);
                    resolve();
                };
                killer.once("close", done);
                killer.once("error", done);
            });
        }
        else {
            try {
                process.kill(-pid, "SIGKILL");
            }
            catch {
                /* child already gone */
            }
        }
        this.child.kill("SIGKILL");
    }
}
class OutputQueue {
    items = [];
    done = false;
    error;
    wake;
    push(record) {
        if (this.items.length >= 256)
            throw new ProtocolError("host event consumer is too slow (queue limit 256)");
        this.items.push(record);
        this.wake?.();
    }
    finish(error) {
        this.done = true;
        this.error = error;
        this.wake?.();
    }
    async take() {
        while (true) {
            if (this.error)
                throw this.error;
            const record = this.items.shift();
            if (record)
                return record;
            if (this.done)
                return null;
            await new Promise((resolve) => {
                this.wake = resolve;
            });
            this.wake = undefined;
        }
    }
}

import * as vscode from 'vscode';

import * as Hermes from '@gov.nasa.jpl.hermes/api';
import type { YamcsEvent } from '@gov.nasa.jpl.hermes/rpc';
import { Def, Dictionary, Proto, Value } from '@gov.nasa.jpl.hermes/types';

/**
 * Builds an F Prime dictionary from the one YAMCS mode builds for an instance that
 * fprime-yamcs runs. fprime-yamcs names each command by its deployment, component
 * instance and command name, like /BigData_YamcsDeployment/CdhCore/cmdDisp/CMD_NO_OP_STRING,
 * and assigns its opcode to an argument called OpCode. We name the command the way
 * F Prime does, CdhCore.cmdDisp.CMD_NO_OP_STRING, and take its opcode from that
 * assignment. Its metadata keeps the qualified name, which YAMCS mode issues it by.
 *
 * F Prime identifies a command by its opcode, so we leave out commands without an
 * OpCode assignment. If that leaves none, this isn't an fprime-yamcs instance, so
 * we return undefined.
 */
export function fprimeDictionary(yamcs: Proto.IDictionary): Proto.IDictionary | undefined {
    const out = new Dictionary({ name: `${yamcs.head?.name} (F Prime)`, type: 'fprime' });
    const namespace = out.get('');
    let count = 0;
    for (const cmd of Dictionary.fromProto(yamcs).get('').getCommands()) {
        const opcode = cmd.metadata?.assignments?.OpCode;
        if (opcode === undefined) {
            continue;
        }
        // We drop the leading slash and the deployment from cmd.component, which is like
        // /BigData_YamcsDeployment/CdhCore/cmdDisp
        const component = cmd.component.split('/').slice(2).join('.');
        namespace.addCommand(`${component}.${cmd.mnemonic}`, {
            ...cmd,
            component,
            opcode: Number(opcode),
            arguments: cmd.arguments.map((arg) => ({ ...arg, type: fprimeType(arg.type) })),
        });
        count++;
    }
    return count > 0 ? { ...out.toProto(), id: `${yamcs.id}:fprime` } : undefined;
}

// fprime-yamcs makes F Prime's bool an enumeration called bool, labelled False and True.
// We turn it back into a boolean so cells keep writing true and false.
function fprimeType(type: Def.Type): Def.Type {
    switch (type.kind) {
        case Def.TypeKind.enum:
            return type.name === 'bool' ? { kind: Def.TypeKind.boolean } : type;
        case Def.TypeKind.array:
            return { ...type, type: fprimeType(type.type) };
        case Def.TypeKind.object:
            return { ...type, fields: type.fields.map((field) => ({ ...field, type: fprimeType(field.type) })) };
        default:
            return type;
    }
}

// We send each boolean in a cell's argument, inside arrays and structs too, as True or False, the
// labels of fprime-yamcs's bool enumeration. YAMCS refuses a protobuf boolean for it. A 64-bit
// integer is a Long object, so we only look inside plain objects.
function yamcsValue(value: Value): Value {
    if (typeof value === 'boolean') {
        return value ? 'True' : 'False';
    } else if (Array.isArray(value)) {
        return value.map(yamcsValue);
    } else if (typeof value === 'object' && value.constructor === Object) {
        return Object.fromEntries(Object.entries(value).map(([name, member]) => [name, yamcsValue(member)]));
    }
    return value;
}

// Core's API, VscodeApi, raises YAMCS mode's events through onYamcsEvents, which Hermes.Api doesn't declare
interface YamcsEventSource {
    onYamcsEvents(handler: (instance: string, events: YamcsEvent[]) => void): vscode.Disposable;
}

// The events F Prime's command dispatcher raises to say how a command ended. Each has the
// command's opcode in an argument called Opcode, which fprime-yamcs puts in the event's extra map.
const completionEvents = ['OpCodeCompleted', 'OpCodeError', 'InvalidCommand'];

// The event's name without its component instance, like OpCodeCompleted
function eventName(event: YamcsEvent): string {
    return event.type?.split('.').pop() ?? '';
}

interface Waiter {
    opcode?: number;
    // Takes the waiting command's completion event, or undefined if YAMCS mode's connection drops
    done: (event: YamcsEvent | undefined) => void;
}

/**
 * Runs F Prime cells on YAMCS mode's connection. For each command we wait out its
 * relative time tag, send it through YAMCS, then wait for the flight software's
 * completion event with the command's opcode. The cell stops at the first command
 * that fails, with the event that says why.
 *
 * We subscribe to YAMCS mode's events once, in the constructor. A new subscription
 * starts with the newest events in YAMCS's archive, and an old completion event
 * among them could pass for a waiting command's. A reconnect resends them, so we
 * fail every waiting command when the connection changes.
 */
export class YamcsRunner implements vscode.Disposable {
    private readonly waiting: Waiter[] = [];
    private readonly subscription: vscode.Disposable;
    private readonly connectionChanges: vscode.Disposable;

    constructor(api: Hermes.Api) {
        this.connectionChanges = api.onFswChange(() => this.waiting.splice(0).forEach((w) => w.done(undefined)));
        this.subscription = (api as Hermes.Api & YamcsEventSource).onYamcsEvents((_, events) => {
            for (const event of events) {
                if (!completionEvents.includes(eventName(event))) {
                    continue;
                }
                const i = this.waiting.findIndex((w) => w.opcode === Number(event.extra?.Opcode));
                if (i >= 0) {
                    this.waiting.splice(i, 1)[0].done(event);
                }
            }
        });
    }

    async run(fsw: Hermes.Fsw, seq: Hermes.CommandSequence, token: vscode.CancellationToken): Promise<boolean> {
        if (!fsw.command) {
            throw new Error(`${fsw.id} can't run F Prime commands`);
        }

        for (const cmd of seq.commands) {
            await cancellable(delay(Number(cmd.metadata?.relativeTimeDelayMs ?? 0)), token);

            const name = `${cmd.def.component}.${cmd.def.mnemonic}`;
            // We start waiting for the completion event before we send the command. The event can reach us
            // before fsw.command resolves, and we drop events no command is waiting for.
            let waiter!: Waiter;
            const completion = new Promise<YamcsEvent | undefined>((done) => {
                waiter = { opcode: cmd.def.opcode, done };
            });
            this.waiting.push(waiter);

            try {
                await fsw.command({ ...cmd, args: cmd.args.map(yamcsValue) }, token);
                const event = await cancellable(completion, token);
                if (!event) {
                    throw new Error(`Hermes lost YAMCS mode's connection before ${name} completed, so its result is unknown`);
                }
                if (eventName(event) !== 'OpCodeCompleted') {
                    throw new Error(`${name} failed: ${event.message}`);
                }
            } finally {
                // We remove the waiter if a failed send or a cancelled cell left it waiting, so it can't take the
                // completion event of a later command with the same opcode.
                const i = this.waiting.indexOf(waiter);
                if (i >= 0) {
                    this.waiting.splice(i, 1);
                }
            }
        }
        return true;
    }

    dispose() {
        this.subscription.dispose();
        this.connectionChanges.dispose();
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Settles as promise does, or rejects as soon as token is cancelled
function cancellable<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<T> {
    return new Promise((resolve, reject) => {
        const onCancel = token.onCancellationRequested(() => reject(new Error('Cancelled')));
        if (token.isCancellationRequested) {
            reject(new Error('Cancelled'));
        }
        promise.then(resolve, reject).finally(() => onCancel.dispose());
    });
}

import { Def, Dictionary, Proto } from '@gov.nasa.jpl.hermes/types';

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

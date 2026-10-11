import fs from "node:fs";
import { listAgentIds, resolveAgentSkillsFilter, resolveAgentWorkspaceDir, } from "../agents/agent-scope.js";
import { buildWorkspaceSkillCommandSpecs } from "../agents/skills.js";
import { logVerbose } from "../globals.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { listChatCommands } from "./commands-registry.js";
export function listReservedChatSlashCommandNames(extraNames = []) {
    const reserved = new Set();
    for (const command of listChatCommands()) {
        if (command.nativeName) {
            reserved.add(command.nativeName.toLowerCase());
        }
        for (const alias of command.textAliases) {
            const trimmed = alias.trim();
            if (!trimmed.startsWith("/")) {
                continue;
            }
            reserved.add(trimmed.slice(1).toLowerCase());
        }
    }
    for (const name of extraNames) {
        const trimmed = name.trim().toLowerCase();
        if (trimmed) {
            reserved.add(trimmed);
        }
    }
    return reserved;
}
export function listSkillCommandsForWorkspace(params) {
    return buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
        config: params.cfg,
        skillFilter: params.skillFilter,
        eligibility: { remote: getRemoteSkillEligibility() },
        reservedNames: listReservedChatSlashCommandNames(),
    });
}
function dedupeBySkillName(commands) {
    const seen = new Set();
    const out = [];
    for (const cmd of commands) {
        const key = cmd.skillName.trim().toLowerCase();
        if (key && seen.has(key)) {
            continue;
        }
        if (key) {
            seen.add(key);
        }
        out.push(cmd);
    }
    return out;
}
export function listSkillCommandsForAgents(params) {
    const mergeSkillFilters = (existing, incoming) => {
        // undefined = no allowlist (unrestricted); [] = explicit empty allowlist (no skills).
        // If any agent is unrestricted for this workspace, keep command discovery unrestricted.
        if (existing === undefined || incoming === undefined) {
            return undefined;
        }
        // An empty allowlist contributes no skills but does not widen the merge to unrestricted.
        if (existing.length === 0) {
            return Array.from(new Set(incoming));
        }
        if (incoming.length === 0) {
            return Array.from(new Set(existing));
        }
        return Array.from(new Set([...existing, ...incoming]));
    };
    const agentIds = params.agentIds ?? listAgentIds(params.cfg);
    const used = listReservedChatSlashCommandNames();
    const entries = [];
    // Group by canonical workspace to avoid duplicate registration when multiple
    // agents share the same directory (#5717), while still honoring per-agent filters.
    const workspaceFilters = new Map();
    for (const agentId of agentIds) {
        const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
        if (!fs.existsSync(workspaceDir)) {
            logVerbose(`Skipping agent "${agentId}": workspace does not exist: ${workspaceDir}`);
            continue;
        }
        let canonicalDir;
        try {
            canonicalDir = fs.realpathSync(workspaceDir);
        }
        catch {
            logVerbose(`Skipping agent "${agentId}": cannot resolve workspace: ${workspaceDir}`);
            continue;
        }
        const skillFilter = resolveAgentSkillsFilter(params.cfg, agentId);
        const existing = workspaceFilters.get(canonicalDir);
        if (existing) {
            existing.skillFilter = mergeSkillFilters(existing.skillFilter, skillFilter);
            continue;
        }
        workspaceFilters.set(canonicalDir, {
            workspaceDir,
            skillFilter,
        });
    }
    for (const { workspaceDir, skillFilter } of workspaceFilters.values()) {
        const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
            config: params.cfg,
            skillFilter,
            eligibility: { remote: getRemoteSkillEligibility() },
            reservedNames: used,
        });
        for (const command of commands) {
            used.add(command.name.toLowerCase());
            entries.push(command);
        }
    }
    return dedupeBySkillName(entries);
}
export const __testing = {
    dedupeBySkillName,
};
function normalizeSkillCommandLookup(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-");
}
function findSkillCommand(skillCommands, rawName) {
    const trimmed = rawName.trim();
    if (!trimmed) {
        return undefined;
    }
    const lowered = trimmed.toLowerCase();
    const normalized = normalizeSkillCommandLookup(trimmed);
    return skillCommands.find((entry) => {
        if (entry.name.toLowerCase() === lowered) {
            return true;
        }
        if (entry.skillName.toLowerCase() === lowered) {
            return true;
        }
        return (normalizeSkillCommandLookup(entry.name) === normalized ||
            normalizeSkillCommandLookup(entry.skillName) === normalized);
    });
}
export function resolveSkillCommandInvocation(params) {
    const trimmed = params.commandBodyNormalized.trim();
    if (!trimmed.startsWith("/")) {
        return null;
    }
    const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!match) {
        return null;
    }
    const commandName = match[1]?.trim().toLowerCase();
    if (!commandName) {
        return null;
    }
    if (commandName === "skill") {
        const remainder = match[2]?.trim();
        if (!remainder) {
            return null;
        }
        const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
        if (!skillMatch) {
            return null;
        }
        const skillCommand = findSkillCommand(params.skillCommands, skillMatch[1] ?? "");
        if (!skillCommand) {
            return null;
        }
        const args = skillMatch[2]?.trim();
        return { command: skillCommand, args: args || undefined };
    }
    const command = params.skillCommands.find((entry) => entry.name.toLowerCase() === commandName);
    if (!command) {
        return null;
    }
    const args = match[2]?.trim();
    return { command, args: args || undefined };
}

import * as _opencode_ai_plugin from '@opencode-ai/plugin';
import { Config } from '@opencode-ai/plugin';
import { z } from 'zod';

declare const _default: (_input: _opencode_ai_plugin.PluginInput, options: _opencode_ai_plugin.PluginOptions | undefined) => Promise<{
    config(input: Config): Promise<void>;
    tool: {
        [x: string]: {
            description: string;
            args: {
                query: z.ZodString;
                contextSize: z.ZodOptional<z.ZodEnum<{
                    low: "low";
                    medium: "medium";
                    high: "high";
                }>>;
            };
            execute(args: {
                query: string;
                contextSize?: "low" | "medium" | "high" | undefined;
            }, context: _opencode_ai_plugin.ToolContext): Promise<_opencode_ai_plugin.ToolResult>;
        };
    };
}>;

export { _default as default };

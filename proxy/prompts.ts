import { getImageDataUri } from './image.ts';
import type { ChatMessage, ModelRef } from './types.ts';
import { logger } from './logger.ts';

/** A text part in a prompt. */
interface TextPartInput {
    type: 'text';
    text: string;
}

/** A file/image part in a prompt — matches PromptInput.FileAttachment ({ uri, name }). */
interface FilePartInput {
    type: 'file';
    mime: string;
    filename?: string;
    uri: string;
}

/** A prompt part sent to the OpenCode server (text or file/image). */
type PromptPart = TextPartInput | FilePartInput;

function parseModel(model: unknown): ModelRef | null {
    if (typeof model !== 'string') return null;
    const trimmed = model.trim();
    if (!trimmed) return null;
    if (trimmed.includes('/')) {
        const separatorIndex = trimmed.indexOf('/');
        const providerId = trimmed.slice(0, separatorIndex).trim();
        const modelId = trimmed.slice(separatorIndex + 1).trim();
        if (!providerId || !modelId) return null;
        return { providerId, modelId };
    }
    // Tolerate bare model ids (e.g. pi's native opencode catalog sends
    // "mimo-v2.5-free" without provider prefix). Default to opencode provider
    // so the proxy remains compatible with both OpenAI-style
    // "provider/model" and pi's short ids.
    return { providerId: 'opencode', modelId: trimmed };
}

async function buildPromptPartsAndSystem(
    messages: ChatMessage[]
): Promise<{ allParts: PromptPart[]; fullPromptText: string; systemPrompt: string }> {
    const allParts: PromptPart[] = [];
    let fullPromptText = '';
    let systemPrompt = '';

    for (const m of messages) {
        if (m.role === 'system') {
            if (typeof m.content === 'string') {
                systemPrompt += `${m.content}\n`;
            } else if (Array.isArray(m.content)) {
                systemPrompt += `${m.content.map((c) => (c as { text?: string }).text || '').join('\n')}\n`;
            }
            continue;
        }

        const role = m.role === 'assistant' ? 'Assistant' : 'User';

        if (typeof m.content === 'string') {
            allParts.push({ type: 'text', text: m.content });
            fullPromptText += `${role}: ${m.content}\n\n`;
            continue;
        }

        if (!Array.isArray(m.content)) {
            continue;
        }

        const imageFetches: Array<Promise<{ dataUri: string; role: string } | null>> = [];
        for (const part of m.content) {
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
                const text = (part as { text?: string }).text || '';
                allParts.push({ type: 'text', text });
                fullPromptText += `${role}: ${text}\n\n`;
            } else if (part.type === 'image_url' || part.type === 'input_image') {
                const partAny = part as Record<string, unknown>;
                const url: string | undefined =
                    typeof partAny.image_url === 'string'
                        ? partAny.image_url
                        : (((partAny.image_url as { url?: string } | undefined)?.url ||
                              partAny.url) as string | undefined);

                if (!url) {
                    continue;
                }

                imageFetches.push(
                    getImageDataUri(url)
                        .then((dataUri) => ({ dataUri, role }))
                        .catch((e) => {
                            logger.warn(
                                'Skipping image due to error:',
                                (e as { message?: string }).message
                            );
                            return null;
                        })
                );
            }
        }
        if (imageFetches.length > 0) {
            const results = await Promise.all(imageFetches);
            for (const r of results) {
                if (!r) continue;
                const mime = r.dataUri.split(';')[0]!.split(':')[1]!;
                allParts.push({
                    type: 'file',
                    mime,
                    uri: r.dataUri,
                    filename: 'image'
                });
                fullPromptText += `${r.role}: [Image attached]\n\n`;
            }
        }
    }

    return {
        allParts,
        fullPromptText: fullPromptText.trim(),
        systemPrompt: systemPrompt.trim()
    };
}

/**
 * Converts a Responses API `input` array into OpenAI chat messages. Supports
 * string, message, input_text, input_image, function_call and
 * function_call_output items so tool results can be relayed back to the model.
 * This is the canonical implementation; normalizeResponsesInputToMessages delegates to it.
 */
function responsesInputToMessages(input: unknown): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let pendingAssistant: ChatMessage | null = null;

    const flushAssistant = () => {
        if (pendingAssistant) {
            messages.push(pendingAssistant);
            pendingAssistant = null;
        }
    };

    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
        return messages;
    }
    if (
        input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        (input as { role?: string }).role &&
        (input as { content?: unknown }).content !== undefined
    ) {
        const objInput = input as { role?: string; content?: unknown };
        messages.push({
            role: objInput.role as ChatMessage['role'],
            content: objInput.content as ChatMessage['content']
        });
        return messages;
    }
    if (!Array.isArray(input)) {
        return messages;
    }

    for (const item of input) {
        if (typeof item === 'string') {
            flushAssistant();
            messages.push({ role: 'user', content: item });
            continue;
        }
        if (!item || typeof item !== 'object') continue;

        const typed = item as Record<string, unknown> & {
            type?: string;
            role?: string;
            content?: unknown;
            text?: string;
            image_url?: string;
            url?: string;
            call_id?: string;
            id?: string;
            name?: string;
            arguments?: unknown;
            output?: unknown;
        };

        switch (typed.type) {
            case 'function_call': {
                if (!pendingAssistant) {
                    pendingAssistant = { role: 'assistant', content: '', tool_calls: [] };
                }
                pendingAssistant.tool_calls!.push({
                    id: (typed.call_id || typed.id || '') as string,
                    type: 'function',
                    function: {
                        name: (typed.name || '') as string,
                        arguments:
                            typeof typed.arguments === 'string'
                                ? (typed.arguments as string)
                                : JSON.stringify(typed.arguments || {})
                    }
                });
                break;
            }
            case 'function_call_output': {
                flushAssistant();
                messages.push({
                    role: 'tool',
                    tool_call_id: (typed.call_id || typed.id || '') as string,
                    content:
                        typeof typed.output === 'string'
                            ? (typed.output as string)
                            : JSON.stringify(typed.output ?? '')
                });
                break;
            }
            case 'message': {
                const content = typed.content;
                let text = '';
                if (typeof content === 'string') {
                    text = content;
                } else if (Array.isArray(content)) {
                    text = (content as Array<{ type?: string; text?: string }>)
                        .filter(
                            (p) =>
                                p.type === 'output_text' ||
                                p.type === 'input_text' ||
                                p.type === 'text'
                        )
                        .map((p) => p.text || '')
                        .join('');
                }
                if (typed.role === 'assistant' && pendingAssistant) {
                    pendingAssistant.content =
                        `${pendingAssistant.content || ''}${text}`.trimStart();
                    break;
                }
                flushAssistant();
                messages.push({
                    role: (typed.role === 'assistant'
                        ? 'assistant'
                        : 'user') as ChatMessage['role'],
                    content: text
                });
                break;
            }
            case 'input_text': {
                flushAssistant();
                messages.push({
                    role: 'user',
                    content: [{ type: 'input_text', text: (typed.text as string) || '' }]
                });
                break;
            }
            case 'input_image': {
                flushAssistant();
                messages.push({
                    role: 'user',
                    content: [
                        {
                            type: 'input_image',
                            image_url: (typed.image_url as string) || (typed.url as string) || ''
                        }
                    ]
                });
                break;
            }
            default: {
                if (typed.role && typed.content !== undefined) {
                    flushAssistant();
                    messages.push({
                        role: typed.role as ChatMessage['role'],
                        content: typed.content as ChatMessage['content']
                    });
                }
            }
        }
    }
    flushAssistant();
    return messages;
}

function normalizeResponsesInputToMessages({
    input,
    instructions
}: {
    input: unknown;
    instructions?: unknown;
}): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (instructions && typeof instructions === 'string') {
        messages.push({ role: 'system', content: instructions });
    }
    messages.push(...responsesInputToMessages(input));
    return messages;
}

export {
    parseModel,
    buildPromptPartsAndSystem,
    responsesInputToMessages,
    normalizeResponsesInputToMessages
};
export type { PromptPart };

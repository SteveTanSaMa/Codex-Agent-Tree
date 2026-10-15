# Stoneforge transport provenance

Source: Stoneforge `packages/smithy/src/providers/codex/jsonrpc-client.ts`, commit `0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95`, Apache-2.0.

https://github.com/stoneforge-ai/stoneforge/blob/0a7052a9ffa1fb42fafbff9d9b6b83fa48cdad95/packages/smithy/src/providers/codex/jsonrpc-client.ts

The multiplexing, handler registration and JSONL transport structure are adapted from that module. Changes for Agent Tree: deadlines and cancellation, string server request IDs, bounded UTF-8 framing, strict frame validation, transport failure cleanup, handler failure propagation and explicit uncertain-delivery errors. This is a modified module, not the unmodified upstream implementation. Upstream LICENSE and project NOTICE are retained beside it.

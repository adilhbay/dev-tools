import id128 from 'id128';
const { Ulid } = id128;
import { ErrorHandling, FlowItemState, HandleKind, NodeKind } from '@the-dev-tools/spec/buf/api/flow/v1/flow_pb';
import type { ErrorHandlingStrategy, FlowItemStateType, HandleKindType, NodeKindType } from './types.ts';

/**
 * Convert a ULID string to Uint8Array bytes
 */
export function ulidToBytes(ulid: string): Uint8Array {
  return Ulid.fromCanonical(ulid).bytes;
}

/**
 * Convert Uint8Array bytes to ULID string
 */
export function bytesToUlid(bytes: Uint8Array): string {
  return Ulid.construct(bytes).toCanonical();
}

/**
 * Generate a new ULID as bytes
 */
export function generateUlidBytes(): Uint8Array {
  return Ulid.generate().bytes;
}

/**
 * Generate a new ULID as string
 */
export function generateUlid(): string {
  return Ulid.generate().toCanonical();
}

/**
 * Convert NodeKind enum to string representation
 */
export function nodeKindToString(kind: NodeKind): NodeKindType | 'unspecified' {
  switch (kind) {
    case NodeKind.MANUAL_START:
      return 'manual_start';
    case NodeKind.HTTP:
      return 'http';
    case NodeKind.CONDITION:
      return 'condition';
    case NodeKind.FOR:
      return 'for';
    case NodeKind.FOR_EACH:
      return 'for_each';
    case NodeKind.JS:
      return 'js';
    default:
      return 'unspecified';
  }
}

/**
 * Convert string to NodeKind enum
 */
export function stringToNodeKind(kind: NodeKindType): NodeKind {
  switch (kind) {
    case 'manual_start':
      return NodeKind.MANUAL_START;
    case 'http':
      return NodeKind.HTTP;
    case 'condition':
      return NodeKind.CONDITION;
    case 'for':
      return NodeKind.FOR;
    case 'for_each':
      return NodeKind.FOR_EACH;
    case 'js':
      return NodeKind.JS;
  }
}

/**
 * Convert HandleKind enum to string representation
 */
export function handleKindToString(kind: HandleKind): HandleKindType | 'unspecified' {
  switch (kind) {
    case HandleKind.THEN:
      return 'then';
    case HandleKind.ELSE:
      return 'else';
    case HandleKind.LOOP:
      return 'loop';
    default:
      return 'unspecified';
  }
}

/**
 * Convert string to HandleKind enum
 */
export function stringToHandleKind(kind: HandleKindType): HandleKind {
  switch (kind) {
    case 'then':
      return HandleKind.THEN;
    case 'else':
      return HandleKind.ELSE;
    case 'loop':
      return HandleKind.LOOP;
  }
}

/**
 * Convert FlowItemState enum to string representation
 */
export function flowItemStateToString(state: FlowItemState): FlowItemStateType | 'unspecified' {
  switch (state) {
    case FlowItemState.RUNNING:
      return 'running';
    case FlowItemState.SUCCESS:
      return 'success';
    case FlowItemState.FAILURE:
      return 'failure';
    case FlowItemState.CANCELED:
      return 'canceled';
    default:
      return 'unspecified';
  }
}

/**
 * Convert ErrorHandling enum to string representation
 */
export function errorHandlingToString(handling: ErrorHandling): ErrorHandlingStrategy {
  switch (handling) {
    case ErrorHandling.IGNORE:
      return 'ignore';
    case ErrorHandling.BREAK:
    default:
      return 'break';
  }
}

/**
 * Convert string to ErrorHandling enum
 */
export function stringToErrorHandling(handling: ErrorHandlingStrategy): ErrorHandling {
  switch (handling) {
    case 'ignore':
      return ErrorHandling.IGNORE;
    case 'break':
      return ErrorHandling.BREAK;
  }
}

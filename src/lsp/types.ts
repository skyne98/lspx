// LSP types. We do NOT hand-roll the protocol surface — we re-export the
// canonical, battle-tested definitions from `vscode-languageserver-node`
// (the same implementation VS Code, Helix, and others build on).
//
// Import what you need from here; everything below is upstream-maintained.
// The only things we add ourselves are small presentation helpers.

export {
  // Core data types
  type Position,
  type Range,
  type Location,
  type LocationLink,
  type TextDocumentIdentifier,
  type TextDocumentItem,
  type TextDocumentPositionParams,
  type DocumentSymbol,
  type SymbolInformation,
  type WorkspaceSymbol,
  type Hover,
  type MarkupContent,
  type MarkedString,
  type CompletionItem,
  type CompletionList,
  type Diagnostic,
  type TextEdit,
  type WorkspaceEdit,
  type PrepareRenameResult,
  type CallHierarchyItem,
  type CallHierarchyIncomingCall,
  type CallHierarchyOutgoingCall,
  type TypeHierarchyItem,
  type InitializeResult,
  type ServerCapabilities,
  type TextDocumentSyncOptions,
  // Enums (real runtime values, not just types)
  SymbolKind,
  DiagnosticSeverity,
  CompletionItemKind,
  SymbolTag,
  // Protocol methods / message types
  type ProtocolRequestType,
  type ProtocolNotificationType,
} from "vscode-languageserver-protocol";

import { SymbolKind, DiagnosticSeverity } from "vscode-languageserver-protocol";
import type { SymbolKind as SymbolKindValue, DiagnosticSeverity as DiagnosticSeverityValue } from "vscode-languageserver-protocol";

/** Short human label for a DiagnosticSeverity (1-4). */
export function severityLabel(sev?: DiagnosticSeverityValue | number): string {
  switch (sev) {
    case DiagnosticSeverity.Error: return "error";
    case DiagnosticSeverity.Warning: return "warn";
    case DiagnosticSeverity.Information: return "info";
    case DiagnosticSeverity.Hint: return "hint";
    default: return "diag";
  }
}

/** Short human label for an LSP SymbolKind, for compact agent-facing output. */
export function symbolKindLabel(kind?: SymbolKindValue | DiagnosticSeverityValue | number): string {
  switch (kind) {
    case SymbolKind.File: return "file";
    case SymbolKind.Module: return "module";
    case SymbolKind.Namespace: return "namespace";
    case SymbolKind.Package: return "package";
    case SymbolKind.Class: return "class";
    case SymbolKind.Method: return "method";
    case SymbolKind.Property: return "property";
    case SymbolKind.Field: return "field";
    case SymbolKind.Constructor: return "ctor";
    case SymbolKind.Enum: return "enum";
    case SymbolKind.Interface: return "iface";
    case SymbolKind.Function: return "function";
    case SymbolKind.Variable: return "var";
    case SymbolKind.Constant: return "const";
    case SymbolKind.String: return "string";
    case SymbolKind.Number: return "number";
    case SymbolKind.Boolean: return "bool";
    case SymbolKind.Array: return "array";
    case SymbolKind.Object: return "object";
    case SymbolKind.Key: return "key";
    case SymbolKind.Null: return "null";
    case SymbolKind.EnumMember: return "enum-member";
    case SymbolKind.Struct: return "struct";
    case SymbolKind.Event: return "event";
    case SymbolKind.Operator: return "operator";
    case SymbolKind.TypeParameter: return "typeparam";
    default: return "symbol";
  }
}

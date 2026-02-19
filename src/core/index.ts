// ---------------------------------------------------------------------------
// OpsPilot — Core Public API
// ---------------------------------------------------------------------------
// This barrel re-exports everything a module author or integrator needs.
// Consumers should import from '@core' or 'opspilot/core'.
// ---------------------------------------------------------------------------

// Types
export * from './types';

// Application
export { Application, ApplicationState } from './Application';

// Event Bus
export { EventBus } from './bus';

// Configuration
export { ConfigLoader, ConfigValidator } from './config';
export type { ValidationResult } from './config';

// Modules
export { ModuleLoader, ModuleRegistry, DependencyResolver } from './modules';
export type { DependencyGraph } from './modules';

// Storage
export { MemoryStorage, NamespacedStorage } from './storage';

// Security
export { AuditLogger, ApprovalGate } from './security';

// OpenClaw
export { ToolRegistry } from './openclaw/ToolRegistry';

// ---------------------------------------------------------------------------
// OpsPilot — connector.kubernetes Unit Tests
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  KubernetesConnector,
  K8sEvent,
  K8sPodStatus,
  K8sNodeCondition,
} from '../src/modules/connector.kubernetes/index';
import { ModuleContext, ModuleType } from '../src/core/types/module';
import { NamespacedStorage } from '../src/core/storage/NamespacedStorage';
import { OpsPilotEvent } from '../src/core/types/events';
import { LogIngestedPayload } from '../src/shared/events';
import { createTestInfra, sleep } from './helpers';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeContext(
  infra: ReturnType<typeof createTestInfra>,
  config: Record<string, unknown> = {},
): ModuleContext {
  return {
    moduleId: 'connector.kubernetes',
    config: {
      pollIntervalMs: 60000,
      source: 'k8s-test',
      apiUrl: 'https://k8s.local',
      token: 'test-token',
      tokenPath: '',
      caPath: '',
      namespace: '',
      watchEvents: true,
      watchPods: true,
      watchNodes: false,
      severityMap: {
        Warning: 'warning',
        Normal: 'info',
        CrashLoopBackOff: 'critical',
        OOMKilled: 'critical',
        NodeNotReady: 'critical',
      },
      timeoutMs: 5000,
      ...config,
    },
    bus: infra.bus,
    storage: new NamespacedStorage(infra.storage, 'connector.kubernetes'),
    logger: infra.logger,
    approvalGate: infra.approvalGate,
  };
}

// ── Lifecycle Tests ────────────────────────────────────────────────────────

describe('connector.kubernetes — Lifecycle', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: KubernetesConnector;

  beforeEach(() => {
    infra = createTestInfra();
    mod = new KubernetesConnector();
  });

  afterEach(async () => {
    await mod.stop().catch(() => {});
    await mod.destroy().catch(() => {});
  });

  it('has correct manifest', () => {
    assert.equal(mod.manifest.id, 'connector.kubernetes');
    assert.equal(mod.manifest.type, ModuleType.Connector);
  });

  it('initializes with config', async () => {
    await mod.initialize(makeContext(infra));
    const config = mod.getConfig();
    assert.equal(config.source, 'k8s-test');
    assert.equal(config.apiUrl, 'https://k8s.local');
    assert.equal(config.watchEvents, true);
    assert.equal(config.watchPods, true);
    assert.equal(config.watchNodes, false);
  });

  it('reports healthy status initially', async () => {
    await mod.initialize(makeContext(infra));
    const h = mod.health();
    assert.equal(h.status, 'healthy');
    assert.ok(h.details);
    assert.equal(h.details!.eventsProcessed, 0);
  });
});

// ── K8s Event Parsing ──────────────────────────────────────────────────────

describe('connector.kubernetes — Event Parsing', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: KubernetesConnector;

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new KubernetesConnector();
    await mod.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('parses raw K8s event JSON', () => {
    const raw = {
      type: 'Warning',
      reason: 'FailedScheduling',
      message: 'No nodes available',
      involvedObject: { kind: 'Pod', name: 'web-app-xyz', namespace: 'default' },
      count: 3,
      source: { component: 'default-scheduler' },
    };

    const event = mod.parseK8sEvent(raw);
    assert.equal(event.type, 'Warning');
    assert.equal(event.reason, 'FailedScheduling');
    assert.equal(event.message, 'No nodes available');
    assert.equal(event.involvedObject.kind, 'Pod');
    assert.equal(event.involvedObject.name, 'web-app-xyz');
    assert.equal(event.count, 3);
  });

  it('handles missing fields gracefully', () => {
    const event = mod.parseK8sEvent({});
    assert.equal(event.type, 'Normal');
    assert.equal(event.reason, '');
    assert.equal(event.involvedObject.kind, '');
  });
});

// ── Event Processing ───────────────────────────────────────────────────────

describe('connector.kubernetes — Event Processing', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: KubernetesConnector;
  let emitted: OpsPilotEvent<LogIngestedPayload>[];

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new KubernetesConnector();
    await mod.initialize(makeContext(infra));
    emitted = [];
    infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => { emitted.push(e); });
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('processes a K8s event and emits log.ingested', () => {
    const event: K8sEvent = {
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off restarting failed container',
      involvedObject: { kind: 'Pod', name: 'web-app-abc', namespace: 'prod' },
      count: 5,
    };

    mod.processEvent(event);

    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].payload.line.includes('[K8S_EVENT]'));
    assert.ok(emitted[0].payload.line.includes('Warning'));
    assert.ok(emitted[0].payload.line.includes('web-app-abc'));
    const meta = emitted[0].payload.metadata as Record<string, unknown>;
    assert.equal(meta.opsSeverity, 'warning');
    assert.equal(meta.eventType, 'Warning');
  });

  it('maps event type to correct severity', () => {
    mod.processEvent({
      type: 'Normal',
      reason: 'Scheduled',
      message: 'Successfully assigned',
      involvedObject: { kind: 'Pod', name: 'p1' },
    });

    const meta = emitted[0].payload.metadata as Record<string, unknown>;
    assert.equal(meta.opsSeverity, 'info');
  });

  it('tracks event metrics', () => {
    mod.processEvent({
      type: 'Warning',
      reason: 'x',
      message: 'm',
      involvedObject: { kind: 'Pod', name: 'p1' },
    });
    mod.processEvent({
      type: 'Normal',
      reason: 'y',
      message: 'n',
      involvedObject: { kind: 'Service', name: 's1' },
    });

    assert.equal(mod.getMetrics().eventsProcessed, 2);
  });
});

// ── Pod Status Processing ──────────────────────────────────────────────────

describe('connector.kubernetes — Pod Status', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: KubernetesConnector;
  let emitted: OpsPilotEvent<LogIngestedPayload>[];

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new KubernetesConnector();
    await mod.initialize(makeContext(infra));
    emitted = [];
    infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => { emitted.push(e); });
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('alerts on CrashLoopBackOff', () => {
    const pod: K8sPodStatus = {
      name: 'web-app-xyz',
      namespace: 'default',
      phase: 'Running',
      containerStatuses: [{
        name: 'web',
        ready: false,
        restartCount: 15,
        state: 'waiting',
        reason: 'CrashLoopBackOff',
        message: 'back-off 5m0s restarting failed container',
      }],
    };

    mod.processPodStatus(pod);

    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].payload.line.includes('[K8S_POD]'));
    assert.ok(emitted[0].payload.line.includes('CrashLoopBackOff'));
    const meta = emitted[0].payload.metadata as Record<string, unknown>;
    assert.equal(meta.opsSeverity, 'critical');
    assert.equal(meta.restartCount, 15);
  });

  it('alerts on OOMKilled', () => {
    const pod: K8sPodStatus = {
      name: 'worker-abc',
      namespace: 'prod',
      phase: 'Running',
      containerStatuses: [{
        name: 'worker',
        ready: false,
        restartCount: 3,
        state: 'terminated',
        reason: 'OOMKilled',
      }],
    };

    mod.processPodStatus(pod);

    assert.equal(emitted.length, 1);
    const meta = emitted[0].payload.metadata as Record<string, unknown>;
    assert.equal(meta.opsSeverity, 'critical');
    assert.equal(meta.reason, 'OOMKilled');
  });

  it('deduplicates same pod/container/reason', () => {
    const pod: K8sPodStatus = {
      name: 'web',
      namespace: 'default',
      phase: 'Running',
      containerStatuses: [{
        name: 'app',
        ready: false,
        restartCount: 5,
        state: 'waiting',
        reason: 'CrashLoopBackOff',
      }],
    };

    mod.processPodStatus(pod);
    mod.processPodStatus(pod); // duplicate

    assert.equal(emitted.length, 1);
  });

  it('alerts again after clearing pod states', () => {
    const pod: K8sPodStatus = {
      name: 'web',
      namespace: 'default',
      phase: 'Running',
      containerStatuses: [{
        name: 'app',
        ready: false,
        restartCount: 5,
        state: 'waiting',
        reason: 'CrashLoopBackOff',
      }],
    };

    mod.processPodStatus(pod);
    mod.clearPodStates();
    mod.processPodStatus(pod);

    assert.equal(emitted.length, 2);
  });

  it('ignores healthy containers', () => {
    const pod: K8sPodStatus = {
      name: 'web',
      namespace: 'default',
      phase: 'Running',
      containerStatuses: [{
        name: 'app',
        ready: true,
        restartCount: 0,
        state: 'running',
      }],
    };

    mod.processPodStatus(pod);
    assert.equal(emitted.length, 0);
  });
});

// ── Node Condition Processing ──────────────────────────────────────────────

describe('connector.kubernetes — Node Conditions', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: KubernetesConnector;
  let emitted: OpsPilotEvent<LogIngestedPayload>[];

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new KubernetesConnector();
    await mod.initialize(makeContext(infra));
    emitted = [];
    infra.bus.subscribe<LogIngestedPayload>('log.ingested', (e) => { emitted.push(e); });
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('alerts on NodeNotReady', () => {
    const node: K8sNodeCondition = {
      nodeName: 'node-01',
      conditions: [
        { type: 'Ready', status: 'False', reason: 'KubeletNotReady', message: 'container runtime not ready' },
      ],
    };

    mod.processNodeConditions(node);

    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].payload.line.includes('[K8S_NODE]'));
    assert.ok(emitted[0].payload.line.includes('NodeNotReady'));
    const meta = emitted[0].payload.metadata as Record<string, unknown>;
    assert.equal(meta.opsSeverity, 'critical');
  });

  it('alerts on MemoryPressure', () => {
    const node: K8sNodeCondition = {
      nodeName: 'node-02',
      conditions: [
        { type: 'MemoryPressure', status: 'True', message: 'memory pressure detected' },
        { type: 'Ready', status: 'True' }, // healthy — should not trigger
      ],
    };

    mod.processNodeConditions(node);

    assert.equal(emitted.length, 1);
    assert.ok(emitted[0].payload.line.includes('MemoryPressure'));
  });

  it('ignores healthy node conditions', () => {
    const node: K8sNodeCondition = {
      nodeName: 'node-03',
      conditions: [
        { type: 'Ready', status: 'True' },
        { type: 'MemoryPressure', status: 'False' },
        { type: 'DiskPressure', status: 'False' },
      ],
    };

    mod.processNodeConditions(node);
    assert.equal(emitted.length, 0);
  });
});

// ── Pod Parsing ────────────────────────────────────────────────────────────

describe('connector.kubernetes — Pod Parsing', () => {
  let infra: ReturnType<typeof createTestInfra>;
  let mod: KubernetesConnector;

  beforeEach(async () => {
    infra = createTestInfra();
    mod = new KubernetesConnector();
    await mod.initialize(makeContext(infra));
  });

  afterEach(async () => {
    await mod.destroy().catch(() => {});
  });

  it('parses raw pod JSON', () => {
    const raw = {
      metadata: { name: 'web-abc', namespace: 'prod' },
      status: {
        phase: 'Running',
        containerStatuses: [{
          name: 'web',
          ready: true,
          restartCount: 2,
          state: { running: { startedAt: '2024-01-15T10:00:00Z' } },
        }],
      },
    };

    const pod = mod.parsePodStatus(raw);
    assert.equal(pod.name, 'web-abc');
    assert.equal(pod.namespace, 'prod');
    assert.equal(pod.phase, 'Running');
    assert.equal(pod.containerStatuses.length, 1);
    assert.equal(pod.containerStatuses[0].state, 'running');
    assert.equal(pod.containerStatuses[0].ready, true);
  });

  it('parses waiting container state', () => {
    const raw = {
      metadata: { name: 'web-abc', namespace: 'prod' },
      status: {
        phase: 'Pending',
        containerStatuses: [{
          name: 'web',
          ready: false,
          restartCount: 10,
          state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } },
        }],
      },
    };

    const pod = mod.parsePodStatus(raw);
    assert.equal(pod.containerStatuses[0].state, 'waiting');
    assert.equal(pod.containerStatuses[0].reason, 'CrashLoopBackOff');
    assert.equal(pod.containerStatuses[0].message, 'back-off');
  });
});

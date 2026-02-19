// ---------------------------------------------------------------------------
// OpsPilot — Main Entry Point
// ---------------------------------------------------------------------------
// Boots the application with the default (or CLI-specified) config file.
// ---------------------------------------------------------------------------

import { Application } from './core/Application';
import { ApprovalCLI } from './cli';
import { FileTailConnector } from './modules/connector.fileTail';
import { RegexDetector } from './modules/detector.regex';
import { IncidentStore } from './modules/enricher.incidentStore';
import { AISummaryEnricher } from './modules/enricher.aiSummary';
import { SafeActionModule } from './modules/action.safe';
import { OpenClawToolsModule } from './modules/openclaw.tools';
import { NotifierChannelsModule } from './modules/notifier.channels';
import { ThresholdDetector } from './modules/detector.threshold';
import { RestApiModule } from './modules/ui.api';
import { WebSocketModule } from './modules/ui.websocket';
import { MetricCollector } from './modules/connector.metrics';
import { SlackNotifier } from './modules/notifier.slack';
import { PagerDutyNotifier } from './modules/notifier.pagerduty';
import { IncidentCorrelator } from './modules/enricher.correlator';
import { HealthCheckConnector } from './modules/connector.healthCheck';
import { DedupEnricher } from './modules/enricher.dedup';
import { EscalationEngine } from './modules/action.escalation';
import { RunbookEngine } from './modules/action.runbook';
import { TeamsNotifier } from './modules/notifier.teams';
import { SyslogConnector } from './modules/connector.syslog';
import { JournaldConnector } from './modules/connector.journald';
import { KubernetesConnector } from './modules/connector.kubernetes';
import { CloudWatchConnector } from './modules/connector.cloudwatch';
import { EmailNotifier } from './modules/notifier.email';
import { DashboardModule } from './modules/ui.dashboard';
import { AnomalyDetector } from './modules/detector.anomaly';

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? 'config/default.yaml';

  const app = new Application();

  // Keep references for dependency injection
  const incidentStore = new IncidentStore();
  const openclawTools = new OpenClawToolsModule();
  const restApi = new RestApiModule();
  const wsModule = new WebSocketModule();
  const dashboardModule = new DashboardModule();

  // ── Register module factories ──────────────────────────────────────────
  app.registerModule('connector.fileTail', () => new FileTailConnector());
  app.registerModule('connector.metrics', () => new MetricCollector());
  app.registerModule('detector.regex', () => new RegexDetector());
  app.registerModule('enricher.incidentStore', () => incidentStore);
  app.registerModule('enricher.aiSummary', () => new AISummaryEnricher());
  app.registerModule('action.safe', () => new SafeActionModule());
  app.registerModule('openclaw.tools', () => openclawTools);
  app.registerModule('notifier.channels', () => new NotifierChannelsModule());
  app.registerModule('detector.threshold', () => new ThresholdDetector());
  app.registerModule('ui.api', () => restApi);
  app.registerModule('ui.websocket', () => wsModule);
  app.registerModule('notifier.slack', () => new SlackNotifier());
  app.registerModule('notifier.pagerduty', () => new PagerDutyNotifier());
  app.registerModule('enricher.correlator', () => new IncidentCorrelator());
  app.registerModule('connector.healthCheck', () => new HealthCheckConnector());
  app.registerModule('enricher.dedup', () => new DedupEnricher());
  app.registerModule('action.escalation', () => new EscalationEngine());
  app.registerModule('action.runbook', () => new RunbookEngine());
  app.registerModule('notifier.teams', () => new TeamsNotifier());
  app.registerModule('connector.syslog', () => new SyslogConnector());
  app.registerModule('connector.journald', () => new JournaldConnector());
  app.registerModule('connector.kubernetes', () => new KubernetesConnector());
  app.registerModule('connector.cloudwatch', () => new CloudWatchConnector());
  app.registerModule('notifier.email', () => new EmailNotifier());
  app.registerModule('ui.dashboard', () => dashboardModule);
  app.registerModule('detector.anomaly', () => new AnomalyDetector());

  // Inject dependencies after core subsystems are ready, before module init
  app.onPreInit(() => {
    openclawTools.setDependencies(app.getToolRegistry(), incidentStore);
    restApi.setDependencies({
      storage: app.getStorage(),
      approvalGate: app.getApprovalGate(),
      auditLogger: app.getAuditLogger(),
      toolRegistry: app.getToolRegistry(),
      authService: app.getAuthService(),
      getModuleHealths: () => {
        const healths: Record<string, any> = {};
        for (const id of app.getModuleRegistry().getRegisteredIds()) {
          const h = app.getModuleRegistry().getHealth(id);
          if (h) healths[id] = h;
        }
        return healths;
      },
    });
    dashboardModule.setDependencies({
      authService: app.getAuthService(),
      getModuleHealths: () => {
        const healths: Record<string, any> = {};
        for (const id of app.getModuleRegistry().getRegisteredIds()) {
          const h = app.getModuleRegistry().getHealth(id);
          if (h) healths[id] = h;
        }
        return healths;
      },
    });
  });

  // Start the application
  await app.start(configPath);

  console.log('\n✅ OpsPilot is running with all modules.\n');
  console.log('Registered OpenClaw tools:');
  const tools = app.getToolRegistry().listTools();
  for (const tool of tools) {
    console.log(`  • ${tool.name} — ${tool.description}`);
  }

  // Start the interactive CLI for approval management
  const enableCLI = process.argv.includes('--cli');
  if (enableCLI) {
    const cli = new ApprovalCLI({
      storage: app.getStorage(),
      approvalGate: app.getApprovalGate(),
      auditLogger: app.getAuditLogger(),
      bus: app.getBus(),
      logger: app.getLogger(),
      operatorId: process.argv[process.argv.indexOf('--operator') + 1] ?? 'operator',
    });
    cli.start();
  }
}

main().catch((err) => {
  console.error('OpsPilot failed to start:', err);
  process.exit(1);
});

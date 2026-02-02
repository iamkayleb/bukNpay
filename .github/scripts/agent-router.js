/**
 * Agent Router - Unified routing logic for multi-agent system
 *
 * This script provides centralized agent detection and routing based on:
 * - PR/Issue labels (agent:codex, agent:claude, agent:gemini)
 * - Registry configuration (.github/agents/registry.yml)
 *
 * Usage in GitHub Actions:
 *   const { detectAgent, getAgentConfig, validateSecrets } = require('./agent-router.js');
 *   const agent = await detectAgent(github, context, prNumber);
 *
 * Note: Requires js-yaml package. In GitHub Actions, install with:
 *   npm install js-yaml
 */

const fs = require('fs');
const path = require('path');

// Try to load js-yaml, provide fallback for environments without it
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  // Fallback: simple YAML parser for basic registry structure
  yaml = {
    load: (content) => {
      // Basic parser for our registry format
      // This is a minimal fallback - use js-yaml in production
      console.warn('js-yaml not found, using basic parser');
      const lines = content.split('\n');
      const result = { agents: {} };
      let currentAgent = null;

      for (const line of lines) {
        if (line.match(/^default_agent:\s*(\w+)/)) {
          result.default_agent = line.match(/^default_agent:\s*(\w+)/)[1];
        } else if (line.match(/^\s{2}(\w+):$/)) {
          currentAgent = line.match(/^\s{2}(\w+):$/)[1];
          result.agents[currentAgent] = {};
        } else if (currentAgent && line.match(/^\s{4}(\w+):\s*"?([^"]+)"?/)) {
          const match = line.match(/^\s{4}(\w+):\s*"?([^"]+)"?/);
          result.agents[currentAgent][match[1]] = match[2].trim();
        }
      }
      return result;
    },
  };
}

// Default registry path
const REGISTRY_PATH = '.github/agents/registry.yml';

// Cache for registry
let registryCache = null;

/**
 * Load the agent registry configuration
 * @param {string} registryPath - Path to registry.yml
 * @returns {Object} Registry configuration
 */
function loadRegistry(registryPath = REGISTRY_PATH) {
  if (registryCache) {
    return registryCache;
  }

  try {
    const registryContent = fs.readFileSync(registryPath, 'utf8');
    registryCache = yaml.load(registryContent);
    return registryCache;
  } catch (error) {
    console.warn(`Could not load registry from ${registryPath}: ${error.message}`);
    // Return minimal default registry
    return {
      default_agent: 'codex',
      agents: {
        codex: {
          name: 'Codex',
          label: 'agent:codex',
          execution_mode: 'github-app',
        },
        claude: {
          name: 'Claude',
          label: 'agent:claude',
          execution_mode: 'cli',
        },
        gemini: {
          name: 'Gemini',
          label: 'agent:gemini',
          execution_mode: 'cli',
        },
      },
    };
  }
}

/**
 * Get all agent labels from registry
 * @param {Object} registry - Registry configuration
 * @returns {Array<string>} Array of agent labels
 */
function getAgentLabels(registry = null) {
  const reg = registry || loadRegistry();
  return Object.values(reg.agents).map((agent) => agent.label);
}

/**
 * Detect which agent to use based on PR/Issue labels
 * @param {Object} github - GitHub API client (octokit)
 * @param {Object} context - GitHub Actions context
 * @param {number} prNumber - PR or Issue number
 * @returns {Promise<Object>} Agent detection result
 */
async function detectAgent(github, context, prNumber) {
  const registry = loadRegistry();
  const { owner, repo } = context.repo;

  let labels = [];

  // Try to get labels from PR first, fall back to issue
  try {
    const { data: pr } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    labels = pr.labels.map((l) => l.name);
  } catch {
    // Not a PR, try as issue
    try {
      const { data: issue } = await github.rest.issues.get({
        owner,
        repo,
        issue_number: prNumber,
      });
      labels = issue.labels.map((l) => l.name);
    } catch (error) {
      console.warn(`Could not fetch labels for #${prNumber}: ${error.message}`);
    }
  }

  // Find matching agent
  for (const [agentId, agentConfig] of Object.entries(registry.agents)) {
    if (labels.includes(agentConfig.label)) {
      return {
        detected: true,
        agentId,
        agentConfig,
        label: agentConfig.label,
        labels,
        source: 'label',
      };
    }
  }

  // No agent label found, use default
  const defaultAgentId = registry.default_agent || 'codex';
  const defaultConfig = registry.agents[defaultAgentId];

  return {
    detected: false,
    agentId: defaultAgentId,
    agentConfig: defaultConfig,
    label: defaultConfig?.label || 'agent:codex',
    labels,
    source: 'default',
  };
}

/**
 * Get configuration for a specific agent
 * @param {string} agentId - Agent identifier (codex, claude, gemini)
 * @returns {Object|null} Agent configuration or null if not found
 */
function getAgentConfig(agentId) {
  const registry = loadRegistry();
  return registry.agents[agentId] || null;
}

/**
 * Get all available agents
 * @returns {Object} Map of agent ID to configuration
 */
function getAllAgents() {
  const registry = loadRegistry();
  return registry.agents;
}

/**
 * Validate that required secrets are available for an agent
 * @param {string} agentId - Agent identifier
 * @param {Object} secrets - Available secrets (from process.env or secrets context)
 * @returns {Object} Validation result
 */
function validateSecrets(agentId, secrets = {}) {
  const config = getAgentConfig(agentId);
  if (!config) {
    return { valid: false, missing: [], error: `Unknown agent: ${agentId}` };
  }

  const required = config.secrets?.required || [];
  const missing = required.filter((secretName) => !secrets[secretName]);

  return {
    valid: missing.length === 0,
    missing,
    required,
    agentId,
    agentName: config.name,
  };
}

/**
 * Get the prompt file path for a given context
 * @param {string} contextType - Context type (keepalive, ci_fix, etc.)
 * @returns {string} Path to prompt file
 */
function getPromptPath(contextType) {
  const registry = loadRegistry();
  const basePath = registry.prompts?.base_path || '.github/codex/prompts';
  const fileName = registry.prompts?.contexts?.[contextType] || `${contextType}.md`;
  return path.join(basePath, fileName);
}

/**
 * Get error patterns for an agent (for error classification)
 * @param {string} agentId - Agent identifier
 * @returns {Object} Error patterns
 */
function getErrorPatterns(agentId) {
  const registry = loadRegistry();
  return registry.error_patterns?.[agentId] || {};
}

/**
 * Check if an agent uses CLI execution mode
 * @param {string} agentId - Agent identifier
 * @returns {boolean} True if CLI mode
 */
function isCliAgent(agentId) {
  const config = getAgentConfig(agentId);
  return config?.execution_mode === 'cli';
}

/**
 * Check if an agent uses GitHub App execution mode
 * @param {string} agentId - Agent identifier
 * @returns {boolean} True if GitHub App mode
 */
function isGitHubAppAgent(agentId) {
  const config = getAgentConfig(agentId);
  return config?.execution_mode === 'github-app';
}

/**
 * Get the setup action path for an agent
 * @param {string} agentId - Agent identifier
 * @returns {string} Path to setup action
 */
function getSetupAction(agentId) {
  const config = getAgentConfig(agentId);
  return config?.setup_action || `setup-${agentId}`;
}

/**
 * Build environment variables for an agent
 * @param {string} agentId - Agent identifier
 * @param {Object} secrets - Available secrets
 * @returns {Object} Environment variables to set
 */
function buildAgentEnv(agentId, secrets = {}) {
  const config = getAgentConfig(agentId);
  if (!config?.env) {
    return {};
  }

  const env = {};
  for (const [key, template] of Object.entries(config.env)) {
    // Replace ${{ secrets.X }} with actual values
    let value = template;
    const matches = template.match(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g);
    if (matches) {
      for (const match of matches) {
        const secretName = match.match(/secrets\.(\w+)/)[1];
        value = value.replace(match, secrets[secretName] || '');
      }
    }

    // Handle default values: ${{ secrets.X || 'default' }}
    const defaultMatch = value.match(/\$\{\{\s*secrets\.\w+\s*\|\|\s*'([^']+)'\s*\}\}/);
    if (defaultMatch) {
      value = defaultMatch[1];
    }

    env[key] = value;
  }

  return env;
}

/**
 * Determine if a label indicates a CLI-based agent
 * Used by keepalive-runner.js to skip orchestrator @codex comments
 * @param {Array<string>} labels - Array of label names
 * @returns {boolean} True if any label is for a CLI agent
 */
function hasCliAgentLabel(labels) {
  const registry = loadRegistry();

  for (const [agentId, config] of Object.entries(registry.agents)) {
    if (config.execution_mode === 'cli' && labels.includes(config.label)) {
      return true;
    }
  }

  return false;
}

/**
 * Get concurrency settings from registry
 * @returns {Object} Concurrency configuration
 */
function getConcurrencySettings() {
  const registry = loadRegistry();
  return (
    registry.concurrency || {
      max_per_repo: 3,
      max_per_pr: 1,
      cooldown_seconds: 60,
    }
  );
}

// Export for use in workflows
module.exports = {
  loadRegistry,
  getAgentLabels,
  detectAgent,
  getAgentConfig,
  getAllAgents,
  validateSecrets,
  getPromptPath,
  getErrorPatterns,
  isCliAgent,
  isGitHubAppAgent,
  getSetupAction,
  buildAgentEnv,
  hasCliAgentLabel,
  getConcurrencySettings,
  REGISTRY_PATH,
};

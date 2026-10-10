"""
GitNexus-Enhanced Agent for SWE-bench Evaluation

Extends mini-swe-agent's DefaultAgent with:
1. Native mode: GitNexus tools via eval-server
2. Baseline mode: Pure mini-swe-agent (no GitNexus — control group)

The agent class itself is minimal — the heavy lifting is in:
- Prompt selection (system + instance templates per mode)
- Metrics tracking (which tools the agent actually uses)

Template structure (matches mini-swe-agent's expectations):
  system_template  → system message: persona + format rules + tool reference
  instance_template → first user message: task + workflow + rules + examples
"""

import logging
from enum import Enum
from pathlib import Path

from minisweagent import Environment, Model
from minisweagent.agents.default import AgentConfig, DefaultAgent
from tool_registry import BINARIES_BY_KEY, TOOL_METRIC_KEYS

logger = logging.getLogger("gitnexus_agent")

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


class GitNexusMode(str, Enum):
    """Evaluation modes for GitNexus integration."""
    BASELINE = "baseline"               # No GitNexus — pure mini-swe-agent
    NATIVE = "native"                   # GitNexus tools via eval-server


class GitNexusAgentConfig(AgentConfig):
    """Extended config for GitNexus evaluation agent."""
    gitnexus_mode: GitNexusMode = GitNexusMode.BASELINE
    track_gitnexus_usage: bool = True


class GitNexusAgent(DefaultAgent):
    """
    Agent that optionally enriches its capabilities with GitNexus code intelligence.

    In BASELINE mode, behaves identically to DefaultAgent.
    In NATIVE mode, GitNexus tools are available as bash commands via eval-server.
    """

    def __init__(self, model: Model, env: Environment, *, config_class: type = GitNexusAgentConfig, **kwargs):
        mode = kwargs.get("gitnexus_mode", GitNexusMode.BASELINE)
        if isinstance(mode, str):
            mode = GitNexusMode(mode)

        # Load system template
        system_file = PROMPTS_DIR / f"system_{mode.value}.jinja"
        if system_file.exists() and "system_template" not in kwargs:
            kwargs["system_template"] = system_file.read_text()

        # Load instance template
        instance_file = PROMPTS_DIR / f"instance_{mode.value}.jinja"
        if instance_file.exists() and "instance_template" not in kwargs:
            kwargs["instance_template"] = instance_file.read_text()

        super().__init__(model, env, config_class=config_class, **kwargs)
        self.gitnexus_mode = mode
        self.gitnexus_metrics = GitNexusMetrics()

    def execute_actions(self, message: dict) -> list[dict]:
        """Execute actions with GitNexus usage tracking."""
        if self.config.track_gitnexus_usage:
            self._track_tool_usage(message)

        outputs = [self.env.execute(action) for action in message.get("extra", {}).get("actions", [])]

        return self.add_messages(
            *self.model.format_observation_messages(message, outputs, self.get_template_vars())
        )

    def _track_tool_usage(self, message: dict):
        """Track which GitNexus tools the agent uses."""
        for action in message.get("extra", {}).get("actions", []):
            command = action.get("command", "")
            for key, binary in BINARIES_BY_KEY.items():
                if binary in command and key in self.gitnexus_metrics.tool_calls:
                    self.gitnexus_metrics.tool_calls[key] += 1
                    break

    def serialize(self, *extra_dicts) -> dict:
        """Serialize with GitNexus-specific metrics."""
        gitnexus_data = {
            "info": {
                "gitnexus": {
                    "mode": self.gitnexus_mode.value,
                    "metrics": self.gitnexus_metrics.to_dict(),
                },
            },
        }
        return super().serialize(gitnexus_data, *extra_dicts)


class GitNexusMetrics:
    """Tracks GitNexus-specific metrics during evaluation."""

    def __init__(self):
        self.tool_calls: dict[str, int] = {key: 0 for key in TOOL_METRIC_KEYS}
        self.index_time: float = 0.0

    @property
    def total_tool_calls(self) -> int:
        return sum(self.tool_calls.values())

    def to_dict(self) -> dict:
        return {
            "tool_calls": dict(self.tool_calls),
            "total_tool_calls": self.total_tool_calls,
            "index_time_seconds": round(self.index_time, 2),
        }

import pytest

GitNexusDockerEnvironment = pytest.importorskip(
    "environments.gitnexus_docker"
).GitNexusDockerEnvironment
tool_registry = pytest.importorskip("tool_registry")
TOOL_SPECS = tool_registry.TOOL_SPECS


def test_render_query_script_uses_endpoint_and_fallback():
    script = GitNexusDockerEnvironment._render_tool_script(TOOL_SPECS["query"], "4848")
    assert "/tool/query" in script
    assert "gitnexus query" in script
    assert "GITNEXUS_EVAL_PORT" in script

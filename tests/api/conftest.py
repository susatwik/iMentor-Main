def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "slow: marks tests as slow (deselect with '-m not slow'). "
        "These call the deep-research orchestrator and take 150-600s each.",
    )

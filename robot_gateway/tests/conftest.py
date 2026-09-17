import pytest


class FakeClock:
    def __init__(self, start_ms: int = 1_000_000):
        self.ms = start_ms

    def now_ms(self) -> int:
        return self.ms

    def advance(self, ms: int) -> None:
        self.ms += ms


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()

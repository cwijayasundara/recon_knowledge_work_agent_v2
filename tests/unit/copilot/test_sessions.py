import threading

import pytest

from onboarding_agent.copilot.sessions import SessionStore, TooManySessions


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def test_create_and_get() -> None:
    s = SessionStore(60, 5)
    sess = s.create("a", "run-1")
    assert len(sess.id) >= 32
    assert s.create("a", None).id != sess.id
    assert s.get(sess.id, "a") is sess
    assert sess.run_id == "run-1"


def test_other_actor_unknown_and_expired_are_indistinguishable() -> None:
    clk = Clock()
    s = SessionStore(10, 5, clock=clk)
    sess = s.create("a", None)
    errs = []
    for sid, actor in [(sess.id, "b"), ("nope", "a")]:
        with pytest.raises(KeyError) as e:
            s.get(sid, actor)
        errs.append(repr(e.value))
    clk.t = 11
    with pytest.raises(KeyError) as e:
        s.get(sess.id, "a")  # expired, even before any sweep
    errs.append(repr(e.value))
    assert len(set(errs)) == 1


def test_get_refreshes_last_used() -> None:
    clk = Clock()
    s = SessionStore(10, 5, clock=clk)
    sess = s.create("a", None)
    clk.t = 8
    s.get(sess.id, "a")
    clk.t = 15
    assert s.get(sess.id, "a") is sess


def test_max_per_actor_and_expired_do_not_count() -> None:
    clk = Clock()
    s = SessionStore(10, 2, clock=clk)
    s.create("a", None)
    s.create("a", None)
    with pytest.raises(TooManySessions):
        s.create("a", None)
    s.create("b", None)
    clk.t = 11
    s.create("a", None)


def test_sweep_drops_expired_and_delete() -> None:
    clk = Clock()
    s = SessionStore(10, 5, clock=clk)
    old = s.create("a", None)
    clk.t = 11
    fresh = s.create("a", None)  # create sweeps
    assert s.sweep() == 0
    with pytest.raises(KeyError):
        s.get(old.id, "a")
    s.delete(fresh.id, "b")  # wrong actor: no-op
    assert s.get(fresh.id, "a") is fresh
    s.delete(fresh.id, "a")
    with pytest.raises(KeyError):
        s.get(fresh.id, "a")


def test_sweep_counts_removed() -> None:
    clk = Clock()
    s = SessionStore(10, 5, clock=clk)
    s.create("a", None)
    s.create("a", None)
    clk.t = 11
    assert s.sweep() == 2


def test_total_cap() -> None:
    s = SessionStore(60, 100, max_total=3)
    for i in range(3):
        s.create(f"a{i}", None)
    with pytest.raises(TooManySessions):
        s.create("z", None)


class _RaceClock:
    """Pauses the first creator between the limit check and the insert (its second clock read)."""

    def __init__(self) -> None:
        self.local = threading.local()
        self.in_window = threading.Event()
        self.other_done = threading.Event()
        self.first = True
        self.guard = threading.Lock()

    def __call__(self) -> float:
        n = getattr(self.local, "n", 0) + 1
        self.local.n = n
        if n == 2:
            with self.guard:
                is_first, self.first = self.first, False
            if is_first:
                self.in_window.set()
                self.other_done.wait(0.5)
        return 0.0


def _race(store_lock_removed: bool) -> int:
    import contextlib

    clk = _RaceClock()
    s = SessionStore(60, 1, clock=clk)
    if store_lock_removed:
        s._lock = contextlib.nullcontext()  # type: ignore[assignment]
    made: list[str] = []

    def first() -> None:
        made.append(s.create("a", None).id)

    def second() -> None:
        clk.in_window.wait(2)
        try:
            made.append(s.create("a", None).id)
        except TooManySessions:
            pass
        finally:
            clk.other_done.set()

    ts = [threading.Thread(target=first), threading.Thread(target=second)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    return len(made)


def test_race_between_count_and_insert_is_prevented_by_lock() -> None:
    assert _race(store_lock_removed=False) == 1


def test_race_test_detects_missing_lock() -> None:
    assert _race(store_lock_removed=True) == 2  # proves the harness exercises the window


def test_concurrent_create_respects_limit() -> None:
    s = SessionStore(60, 5)
    ok: list[str] = []
    fail: list[int] = []
    barrier = threading.Barrier(20)

    def go() -> None:
        barrier.wait()
        try:
            ok.append(s.create("a", None).id)
        except TooManySessions:
            fail.append(1)

    ts = [threading.Thread(target=go) for _ in range(20)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(ok) == 5 and len(fail) == 15


class _SweepClock:
    """The getter reads t=9 and then pauses (inside get, before the lookup and refresh); the sweeper reads t=15."""

    def __init__(self) -> None:
        self.local = threading.local()
        self.armed = False
        self.in_window = threading.Event()
        self.other_done = threading.Event()

    def __call__(self) -> float:
        role = getattr(self.local, "role", "")
        if role == "getter" and self.armed:
            self.armed = False
            self.in_window.set()
            self.other_done.wait(0.5)
            return 9.0
        return 15.0 if role == "sweeper" else 0.0


def _get_during_sweep(store_lock_removed: bool) -> bool:
    """Returns whether the session survived a sweep that ran while get() was in progress."""
    import contextlib

    clk = _SweepClock()
    s = SessionStore(10, 5, clock=clk)
    sess = s.create("a", None)
    if store_lock_removed:
        s._lock = contextlib.nullcontext()  # type: ignore[assignment]
    got: list[bool] = []

    def getter() -> None:
        clk.local.role = "getter"
        clk.armed = True
        try:
            got.append(s.get(sess.id, "a") is sess)
        except KeyError:
            got.append(False)

    def sweeper() -> None:
        clk.local.role = "sweeper"
        clk.in_window.wait(2)
        try:
            s.sweep()  # at t=15 the session is expired unless get() refreshed it to t=9 first
        finally:
            clk.other_done.set()

    ts = [threading.Thread(target=getter), threading.Thread(target=sweeper)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    return got == [True] and sess.id in s._sessions


def test_get_during_sweep() -> None:
    assert _get_during_sweep(store_lock_removed=False)


def test_get_during_sweep_detects_missing_lock() -> None:
    assert not _get_during_sweep(store_lock_removed=True)  # proves the harness reaches the window


def test_hard_lifetime_independent_of_sliding_ttl() -> None:
    clk = Clock()
    s = SessionStore(10, 5, clock=clk, max_lifetime_s=25)
    sess = s.create("a", None)
    for t in (8, 16, 24):
        clk.t = t
        s.get(sess.id, "a")
    clk.t = 25
    with pytest.raises(KeyError):
        s.get(sess.id, "a")
    assert SessionStore(10, 5).max_lifetime_s == 43_200


def test_identity_fields_read_only() -> None:
    s = SessionStore(60, 5)
    sess = s.create("a", "run-1")
    for name, val in [("actor", "b"), ("id", "x"), ("run_id", "r"), ("created", 0.0)]:
        with pytest.raises(AttributeError):
            setattr(sess, name, val)
    with pytest.raises(KeyError):
        s.get(sess.id, "b")
    sess.cells_read += 5  # mutable counters still work
    assert s.get(sess.id, "a").cells_read == 5


def test_delete_reports_whether_it_deleted() -> None:
    s = SessionStore(60, 5)
    sess = s.create("a", None)
    assert s.delete(sess.id, "b") is False
    assert s.delete("nope", "a") is False
    assert s.delete(sess.id, "a") is True
    assert s.delete(sess.id, "a") is False


def test_missing_session_is_session_not_found_and_still_a_key_error() -> None:
    from onboarding_agent.copilot.sessions import SessionNotFound

    store = SessionStore(60, 5)
    with pytest.raises(SessionNotFound):
        store.get("nope", "a")
    assert issubclass(SessionNotFound, KeyError)


def test_every_removal_marks_the_session_closed() -> None:
    now = [0.0]
    store = SessionStore(10, 5, clock=lambda: now[0])
    deleted, expired, swept = store.create("a", None), store.create("a", None), store.create("a", None)
    assert store.delete(deleted.id, "a") and deleted.closed is True
    now[0] = 100
    with pytest.raises(KeyError):
        store.get(expired.id, "a")
    assert expired.closed is True
    store.sweep()
    assert swept.closed is True


def test_sweep_and_get_keep_a_locked_session_until_its_step_ends() -> None:
    now = [0.0]
    store = SessionStore(10, 1, clock=lambda: now[0])
    sess = store.create("a", None)
    sess.lock.acquire()
    now[0] = 100
    assert store.sweep() == 0
    with pytest.raises(KeyError):
        store.get(sess.id, "a")
    with pytest.raises(TooManySessions):
        store.create("a", None)
    assert sess.closed is False
    sess.lock.release()
    store.create("a", None)
    assert sess.closed is True

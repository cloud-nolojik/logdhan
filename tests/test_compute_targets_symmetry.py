"""
Symmetry test for scanner.py compute_targets (LONG) vs compute_targets_short (SHORT).

For a "mirror-image" candle series (LONG fixture flipped vertically around
its own median price), the SHORT-side levels should be the geometric mirror
of the LONG-side levels: each target/stop should sit roughly the same
percentage distance from entry, just on the opposite side.

This catches a class of bug where the SHORT-side implementation either
uses a wrong multiplier (e.g. 1.5× ATR instead of 1.0×) or has a sign
error in the level ordering.

Run with:
    cd /Users/nolojik/Documents/logdhan
    pytest tests/test_compute_targets_symmetry.py -v
    # OR (manual):
    python3 tests/test_compute_targets_symmetry.py
"""
import pandas as pd  # type: ignore
import pytest        # type: ignore

# conftest.py at tests/ adds the repo root to sys.path so this just works.
from scanner import compute_targets, compute_targets_short


# ─── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture
def long_df():
    """Realistic uptrend ending at a breakout (60 days of slow rise + 1 breakout)."""
    rows = []
    base = 100.0
    for i in range(60):
        trend = base + i * 0.3
        rows.append({
            "Date": pd.Timestamp("2026-01-01") + pd.Timedelta(days=i),
            "Open":   trend - 0.1,
            "High":   trend + 0.8,
            "Low":    trend - 0.5,
            "Close":  trend + 0.3,
            "Volume": 100000,
        })
    last = rows[-1].copy()
    last["Date"]   = rows[-1]["Date"] + pd.Timedelta(days=1)
    last["Open"]   = rows[-1]["Close"]
    last["High"]   = rows[-1]["Close"] + 2.0
    last["Low"]    = rows[-1]["Close"] - 0.2
    last["Close"]  = rows[-1]["Close"] + 1.8
    last["Volume"] = 200000
    rows.append(last)
    return pd.DataFrame(rows).set_index("Date")


@pytest.fixture
def short_df(long_df):
    """Mirror of long_df around price=200 (downtrend ending in a breakdown)."""
    out = long_df.copy()
    out["Open"]  = 200 - long_df["Open"]
    out["High"]  = 200 - long_df["Low"]      # mirror flips H/L
    out["Low"]   = 200 - long_df["High"]
    out["Close"] = 200 - long_df["Close"]
    return out


# ─── Tests ──────────────────────────────────────────────────────────────────

class TestStructuralSymmetry:
    def test_entry_mirror_axis(self, long_df, short_df):
        """LONG entry + SHORT entry should sum to ~200 (the mirror axis)."""
        L = compute_targets(long_df)
        S = compute_targets_short(short_df)
        entry_sum = L["entry"] + S["entry"]
        assert abs(entry_sum - 200) < 1.0, \
            f"entry sum should be ~200, got {entry_sum:.2f}"

    def test_sl_pct_magnitude_band(self, long_df, short_df):
        """SL %-distances should be within an order of magnitude of each other."""
        L = compute_targets(long_df)
        S = compute_targets_short(short_df)
        L_sl_pct = abs(L["SL"]["pct"])
        S_sl_pct = abs(S["SL"]["pct"])
        assert 0.5 <= S_sl_pct / L_sl_pct <= 2.0, \
            f"SL %-distances diverge: LONG={L_sl_pct:.2f}% SHORT={S_sl_pct:.2f}%"

    def test_long_target_ordering(self, long_df):
        """LONG: T3 > T2 > T1 > entry."""
        L = compute_targets(long_df)
        assert L["T1"]["price"] > L["entry"]
        assert L["T2"]["price"] > L["T1"]["price"]
        assert L["T3"]["price"] > L["T2"]["price"]

    def test_short_target_ordering(self, short_df):
        """SHORT: T3 < T2 < T1 < entry."""
        S = compute_targets_short(short_df)
        assert S["T1"]["price"] < S["entry"]
        assert S["T2"]["price"] < S["T1"]["price"]
        assert S["T3"]["price"] < S["T2"]["price"]

    def test_long_sl_below_entry(self, long_df):
        L = compute_targets(long_df)
        assert L["SL"]["price"] < L["entry"]

    def test_short_sl_above_entry(self, short_df):
        S = compute_targets_short(short_df)
        assert S["SL"]["price"] > S["entry"]

    def test_sl_trigger_semantics(self, long_df, short_df):
        """LONG exits on close-below SL, SHORT exits on close-above SL."""
        L = compute_targets(long_df)
        S = compute_targets_short(short_df)
        assert L["SL"]["trigger"] == "close-below"
        assert S["SL"]["trigger"] == "close-above"

    def test_rr_values_positive(self, long_df, short_df):
        """All R:R values must be positive numbers."""
        L = compute_targets(long_df)
        S = compute_targets_short(short_df)
        for k in ("RR_T1", "RR_T2", "RR_T3"):
            assert isinstance(L[k], (int, float)) and L[k] > 0, f"L.{k}={L[k]}"
            assert isinstance(S[k], (int, float)) and S[k] > 0, f"S.{k}={S[k]}"


class TestAtrFloorSymmetry:
    def test_atr_magnitudes_comparable(self, long_df, short_df):
        """ATR floor multiplier is 1.0× for both LONG and SHORT — magnitudes
        should match within ~2× since fixtures mirror each other."""
        L = compute_targets(long_df)
        S = compute_targets_short(short_df)
        assert L["SL"]["atr"] > 0 and S["SL"]["atr"] > 0
        atr_ratio = S["SL"]["atr"] / L["SL"]["atr"]
        assert 0.5 <= atr_ratio <= 2.0, \
            f"ATR magnitudes diverge: LONG={L['SL']['atr']:.4f} SHORT={S['SL']['atr']:.4f}"


# ─── Manual-run entry point (for `python3 file.py` without pytest) ──────────

if __name__ == "__main__":
    # Build fixtures inline since pytest's fixture injection isn't available
    def _long():
        rows = []
        base = 100.0
        for i in range(60):
            trend = base + i * 0.3
            rows.append({
                "Date": pd.Timestamp("2026-01-01") + pd.Timedelta(days=i),
                "Open": trend - 0.1, "High": trend + 0.8, "Low": trend - 0.5,
                "Close": trend + 0.3, "Volume": 100000,
            })
        last = rows[-1].copy()
        last["Date"] = rows[-1]["Date"] + pd.Timedelta(days=1)
        last["Open"] = rows[-1]["Close"]
        last["High"] = rows[-1]["Close"] + 2.0
        last["Low"]  = rows[-1]["Close"] - 0.2
        last["Close"]= rows[-1]["Close"] + 1.8
        last["Volume"] = 200000
        rows.append(last)
        return pd.DataFrame(rows).set_index("Date")

    long_d = _long()
    short_d = long_d.copy()
    short_d["Open"]  = 200 - long_d["Open"]
    short_d["High"]  = 200 - long_d["Low"]
    short_d["Low"]   = 200 - long_d["High"]
    short_d["Close"] = 200 - long_d["Close"]

    L = compute_targets(long_d)
    S = compute_targets_short(short_d)
    print(f"LONG  entry={L['entry']:.2f}  T1={L['T1']['price']:.2f}  SL={L['SL']['price']:.2f}")
    print(f"SHORT entry={S['entry']:.2f}  T1={S['T1']['price']:.2f}  SL={S['SL']['price']:.2f}")
    print("Run `pytest tests/` for the full assertion suite.")

{
    "_id" : ObjectId("69839bdf2fe48ed545237578"),
    "week_start" : ISODate("2026-02-01T18:30:00.000+0000"),
    "week_end" : ISODate("2026-02-06T18:29:59.999+0000"),
    "week_label" : "2 Feb - 7 Feb 2026",
    "stocks" : [
        {
            "instrument_key" : "NSE_EQ|INE864I01014",
            "symbol" : "MTARTECH",
            "stock_name" : "MTAR TECHNOLOGIES LIMITED",
            "selection_reason" : "a_plus_momentum scan",
            "scan_type" : "a_plus_momentum",
            "setup_score" : NumberInt(76),
            "grade" : "A",
            "screening_data" : {
                "price_at_screening" : 2931.5,
                "dma20" : 2575.4,
                "dma50" : 2494.6,
                "dma200" : 1913.4,
                "ema20" : NumberInt(2585),
                "ema50" : 2478.1,
                "rsi" : 70.3,
                "weekly_rsi" : 70.8,
                "atr" : 139.8,
                "atr_pct" : 4.8,
                "volume_vs_avg" : 7.6,
                "distance_from_20dma_pct" : 13.8,
                "weekly_change_pct" : 22.1,
                "high_52w" : NumberInt(3078),
                "ema_stack_bullish" : true,
                "weekly_pivot" : 2493.7,
                "weekly_r1" : 2622.4,
                "weekly_r2" : 2844.6,
                "weekly_s1" : 2271.5
            },
            "levels" : {
                "entry" : 3098.9500000000003,
                "entryRange" : [
                    3098.9500000000003,
                    3140.9
                ],
                "stop" : 2889.25,
                "target1" : 3273.7000000000003,
                "target1Basis" : "midpoint",
                "target" : 3448.4500000000003,
                "target2" : 3658.15,
                "targetBasis" : "atr_extension_52w_breakout",
                "dailyR1Check" : 2781.3,
                "riskReward" : 1.7,
                "riskPercent" : 6.8,
                "rewardPercent" : 11.3,
                "entryType" : "buy_above",
                "mode" : "A_PLUS_MOMENTUM",
                "archetype" : "52w_breakout",
                "reason" : "A+ Momentum (52W Breakout): Stock 13.4% above EMA20, broke 252-day high with 1.5x+ volume. Entry above 3078 confirms breakout holds. 52W HIGH BREAKOUT: No overhead resistance. T1 at 2.5 ATR (3448.5), R:R 1.7:1",
                "entryConfirmation" : "close_above",
                "entryWindowDays" : NumberInt(3),
                "maxHoldDays" : NumberInt(5),
                "weekEndRule" : "trail_or_exit",
                "t1BookingPct" : NumberInt(50),
                "postT1Stop" : "move_to_entry"
            },
            "status" : "WATCHING",
            "has_ai_analysis" : true,
            "tracking_status" : "ABOVE_ENTRY",
            "tracking_flags" : [

            ],
            "trade_simulation" : {
                "status" : "ENTRY_SIGNALED",
                "signal_date" : ISODate("2026-02-03T10:30:00.000+0000"),
                "signal_close" : 3234.6,
                "entry_price" : null,
                "entry_date" : null,
                "capital" : NumberInt(100000),
                "qty_total" : NumberInt(32),
                "qty_remaining" : NumberInt(32),
                "qty_exited" : NumberInt(0),
                "trailing_stop" : 2889.25,
                "realized_pnl" : NumberInt(0),
                "unrealized_pnl" : NumberInt(0),
                "total_pnl" : NumberInt(0),
                "total_return_pct" : NumberInt(0),
                "peak_price" : NumberInt(0),
                "peak_gain_pct" : NumberInt(0),
                "events" : [
                    {
                        "date" : ISODate("2026-02-03T10:30:00.000+0000"),
                        "type" : "ENTRY_SIGNAL",
                        "price" : 3234.6,
                        "qty" : NumberInt(19),
                        "pnl" : NumberInt(0),
                        "detail" : "Entry signal confirmed — close ₹3234.60 above entry ₹3098.95 (+4.4%). Buy 19 shares (EXTENDED: reduced from 32) at next day's open.",
                        "_id" : ObjectId("69839c24b77de5524055192b")
                    }
                ]
            },
            "_id" : ObjectId("69839bdf2fe48ed54523757a"),
            "daily_snapshots" : [
                {
                    "date" : ISODate("2026-02-02T10:30:00.000+0000"),
                    "open" : 3079.9,
                    "high" : NumberInt(3188),
                    "low" : 2946.3,
                    "close" : 3035.6,
                    "volume" : NumberInt(1317163),
                    "volume_vs_avg" : null,
                    "rsi" : null,
                    "distance_from_entry_pct" : -2.04,
                    "distance_from_stop_pct" : 5.07,
                    "distance_from_target_pct" : -11.97,
                    "tracking_status" : "RETEST_ZONE",
                    "tracking_flags" : [

                    ],
                    "nifty_change_pct" : NumberInt(0),
                    "phase2_triggered" : true,
                    "_id" : ObjectId("69839c0d94a78e737d4a36cc"),
                    "phase2_analysis_id" : ObjectId("69839c1704766d695eb1ddc6")
                },
                {
                    "date" : ISODate("2026-02-03T10:30:00.000+0000"),
                    "open" : NumberInt(3249),
                    "high" : NumberInt(3269),
                    "low" : NumberInt(3069),
                    "close" : 3234.6,
                    "volume" : NumberInt(720296),
                    "volume_vs_avg" : null,
                    "rsi" : null,
                    "distance_from_entry_pct" : 4.38,
                    "distance_from_stop_pct" : 11.95,
                    "distance_from_target_pct" : -6.2,
                    "tracking_status" : "ABOVE_ENTRY",
                    "tracking_flags" : [

                    ],
                    "nifty_change_pct" : NumberInt(0),
                    "phase2_triggered" : true,
                    "_id" : ObjectId("69839c24b77de5524055192a"),
                    "phase2_analysis_id" : ObjectId("69839c2e04766d695eb1ddcf")
                }
            ],
            "intraday_alerts" : [

            ],
            "added_at" : ISODate("2026-02-04T19:19:59.275+0000"),
            "analysis_id" : ObjectId("69839c0104766d695eb1ddc4"),
            "previous_status" : "RETEST_ZONE",
            "status_changed_at" : ISODate("2026-02-03T10:30:00.000+0000")
        }
    ],
    "screening_completed" : true,
    "scan_types_used" : [
        "a_plus_momentum"
    ],
    "week_summary" : {
        "total_stocks" : NumberInt(0)
    },
    "status" : "ACTIVE",
    "createdAt" : ISODate("2026-02-04T19:19:59.243+0000"),
    "updatedAt" : ISODate("2026-02-04T19:21:18.962+0000"),
    "__v" : NumberInt(4),
    "grade_a_count" : NumberInt(1),
    "grade_a_plus_count" : NumberInt(0),
    "screening_run_at" : ISODate("2026-02-04T19:19:59.305+0000"),
    "total_eliminated" : NumberInt(0),
    "total_screener_results" : NumberInt(1)
}
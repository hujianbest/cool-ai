#!/usr/bin/env python3
"""Tests for hf_gate.py — HarnessFlow 机械门禁脚本。

运行: python3 skills/hf-workflow/scripts/test_hf_gate.py
"""

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hf_gate  # noqa: E402

TS1 = "20260703T100000Z"
TS2 = "20260703T110000Z"
TS3 = "20260703T120000Z"


def make_log(feature: Path, label: str, ts: str, exit_code: int, body: str = "out") -> Path:
    evidence = feature / "evidence"
    evidence.mkdir(exist_ok=True)
    path = evidence / f"{label}-{ts}.log"
    path.write_text(
        "# hf-gate-run\n"
        f"# label: {label}\n"
        "# command: dummy\n"
        f"# started: {ts}\n"
        f"{body}\n"
        f"# exit: {exit_code}\n",
        encoding="utf-8",
    )
    return path


def make_strict_log(feature: Path, label: str, ts: str, exit_code: int,
                    *, header_label: str | None = None,
                    command: str = "dummy",
                    started: str = "2026-07-03T10:00:00+00:00",
                    body: str = "out",
                    magic: str = "# hf-gate-run",
                    suffix: str = "") -> Path:
    evidence = feature / "evidence"
    evidence.mkdir(exist_ok=True)
    path = evidence / f"{label}-{ts}.log"
    path.write_text(
        f"{magic}\n"
        f"# label: {header_label if header_label is not None else label}\n"
        f"# command: {command}\n"
        f"# started: {started}\n"
        f"{body}\n"
        f"# exit: {exit_code}\n"
        f"{suffix}",
        encoding="utf-8",
    )
    return path


def make_frame(feature: Path, tier: int) -> None:
    feature.mkdir(parents=True, exist_ok=True)
    (feature / "frame.md").write_text(
        "# 某特性 Frame\n\n- 意图: 测试用\n"
        f"- 模式: 建造\n- 风险档位: {tier}\n- 档位理由: 测试\n"
        "- 用户可感知: 否\n- 理由: 测试门禁\n",
        encoding="utf-8",
    )


def make_review(feature: Path, name: str, verdict: str = "通过",
                confirm: str = "2026-07-03", method: str = "subagent") -> None:
    reviews = feature / "reviews"
    reviews.mkdir(exist_ok=True)
    lines = [f"# 评审 (第 1 轮)", "", "- 日期: 2026-07-03",
             f"- 评审方式: {method}", f"- 结论: {verdict}"]
    if confirm is not None:
        lines.append(f"- 用户确认: {confirm}")
    lines += ["", "## Findings", "无"]
    (reviews / name).write_text("\n".join(lines) + "\n", encoding="utf-8")


def make_plan(feature: Path, tasks: list[tuple[str, bool]], doc: str = "plan.md") -> None:
    body = ["# 计划", "", "## 任务清单", ""]
    for tid, done in tasks:
        mark = "x" if done else " "
        body.append(f"- [{mark}] {tid} 某任务 (覆盖: FR-1) — 判据: 测试通过")
    (feature / doc).write_text("\n".join(body) + "\n", encoding="utf-8")


def run_gate(argv: list[str]) -> tuple[int, str]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = hf_gate.main(argv)
    return code, buf.getvalue()


class RunCommandTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.feature = Path(self._tmp.name) / "features" / "001-x"
        self.feature.mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def test_run_writes_log_with_header_and_exit_zero(self):
        code, out = run_gate([
            "run", "--feature", str(self.feature), "--label", "t1-green",
            "--", sys.executable, "-c", "print('hello-green')",
        ])
        self.assertEqual(code, 0)
        logs = list((self.feature / "evidence").glob("t1-green-*.log"))
        self.assertEqual(len(logs), 1)
        text = logs[0].read_text(encoding="utf-8")
        self.assertIn("# label: t1-green", text)
        self.assertIn("hello-green", text)
        self.assertIn("# exit: 0", text)
        self.assertIn(str(logs[0]), out)

    def test_run_propagates_nonzero_exit(self):
        code, _ = run_gate([
            "run", "--feature", str(self.feature), "--label", "t1-red",
            "--", sys.executable, "-c", "import sys; print('boom'); sys.exit(3)",
        ])
        self.assertEqual(code, 3)
        logs = list((self.feature / "evidence").glob("t1-red-*.log"))
        self.assertEqual(len(logs), 1)
        self.assertIn("# exit: 3", logs[0].read_text(encoding="utf-8"))

    def test_run_rejects_bad_label(self):
        code, _ = run_gate([
            "run", "--feature", str(self.feature), "--label", "Bad Label!",
            "--", "true",
        ])
        self.assertEqual(code, 2)


class CheckPlanTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.feature = Path(self._tmp.name) / "features" / "001-x"

    def tearDown(self):
        self._tmp.cleanup()

    def check(self, target):
        return run_gate(["check", "--feature", str(self.feature), "--to", target])

    def test_fails_without_frame(self):
        self.feature.mkdir(parents=True)
        code, out = self.check("plan")
        self.assertEqual(code, 1)
        self.assertIn("frame.md", out)

    def test_fails_for_tier1(self):
        make_frame(self.feature, 1)
        make_log(self.feature, "baseline", TS1, 0)
        code, out = self.check("plan")
        self.assertEqual(code, 1)

    def test_passes_with_frame_and_baseline(self):
        make_frame(self.feature, 2)
        make_log(self.feature, "baseline", TS1, 0)
        code, out = self.check("plan")
        self.assertEqual(code, 0, out)

    def test_fails_without_baseline_evidence(self):
        make_frame(self.feature, 2)
        code, out = self.check("plan")
        self.assertEqual(code, 1)
        self.assertIn("baseline", out)


class CheckDesignTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.feature = Path(self._tmp.name) / "features" / "001-x"
        make_frame(self.feature, 3)
        make_log(self.feature, "baseline", TS1, 0)
        (self.feature / "spec.md").write_text("# spec\n内容\n", encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def check(self):
        return run_gate(["check", "--feature", str(self.feature), "--to", "design"])

    def test_fails_without_spec_review(self):
        code, _ = self.check()
        self.assertEqual(code, 1)

    def test_passes_with_approved_spec_review(self):
        make_review(self.feature, "spec-review.md")
        code, out = self.check()
        self.assertEqual(code, 0, out)


class CheckBuildTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.feature = Path(self._tmp.name) / "features" / "001-x"

    def tearDown(self):
        self._tmp.cleanup()

    def check(self):
        return run_gate(["check", "--feature", str(self.feature), "--to", "build"])

    def test_tier1_passes_with_frame_and_baseline(self):
        make_frame(self.feature, 1)
        make_log(self.feature, "baseline", TS1, 0)
        code, out = self.check()
        self.assertEqual(code, 0, out)

    def test_tier2_fails_without_plan_review(self):
        make_frame(self.feature, 2)
        make_log(self.feature, "baseline", TS1, 0)
        make_plan(self.feature, [("T-1", False)])
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("plan-review", out)

    def test_tier2_passes_with_approved_plan_review(self):
        make_frame(self.feature, 2)
        make_log(self.feature, "baseline", TS1, 0)
        make_plan(self.feature, [("T-1", False)])
        make_review(self.feature, "plan-review.md")
        code, out = self.check()
        self.assertEqual(code, 0, out)

    def test_verdict_needs_revision_blocks(self):
        make_frame(self.feature, 2)
        make_log(self.feature, "baseline", TS1, 0)
        make_plan(self.feature, [("T-1", False)])
        make_review(self.feature, "plan-review.md", verdict="需修改")
        code, _ = self.check()
        self.assertEqual(code, 1)

    def test_missing_confirmation_blocks(self):
        make_frame(self.feature, 2)
        make_log(self.feature, "baseline", TS1, 0)
        make_plan(self.feature, [("T-1", False)])
        make_review(self.feature, "plan-review.md", confirm=None)
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("用户确认", out)

    def test_degraded_review_with_auto_approval_blocks(self):
        make_frame(self.feature, 2)
        make_log(self.feature, "baseline", TS1, 0)
        make_plan(self.feature, [("T-1", False)])
        make_review(self.feature, "plan-review.md",
                    confirm="auto-approved 2026-07-03", method="主会话降级")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("主会话降级", out)

    def test_degraded_review_with_real_user_confirmation_passes(self):
        make_frame(self.feature, 2)
        make_log(self.feature, "baseline", TS1, 0)
        make_plan(self.feature, [("T-1", False)])
        make_review(self.feature, "plan-review.md",
                    confirm="2026-07-03", method="主会话降级")
        code, out = self.check()
        self.assertEqual(code, 0, out)

    def test_tier3_requires_both_reviews(self):
        make_frame(self.feature, 3)
        make_log(self.feature, "baseline", TS1, 0)
        (self.feature / "spec.md").write_text("# spec\n内容\n", encoding="utf-8")
        make_plan(self.feature, [("T-1", False)], doc="design.md")
        make_review(self.feature, "spec-review.md")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("design-review", out)
        make_review(self.feature, "design-review.md")
        code, out = self.check()
        self.assertEqual(code, 0, out)


class CheckVerifyTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.feature = Path(self._tmp.name) / "features" / "001-x"
        make_frame(self.feature, 2)
        make_log(self.feature, "baseline", TS1, 0)
        make_review(self.feature, "plan-review.md")

    def tearDown(self):
        self._tmp.cleanup()

    def check(self):
        return run_gate(["check", "--feature", str(self.feature), "--to", "verify"])

    def write_task(self, rest: str, *, done: bool = True):
        mark = "x" if done else " "
        (self.feature / "plan.md").write_text(
            "# 计划\n\n## 任务清单\n\n"
            f"- [{mark}] T-50{rest}\n",
            encoding="utf-8",
        )

    def clear_t50_logs(self):
        evidence = self.feature / "evidence"
        if evidence.is_dir():
            for path in evidence.glob("t50-*.log"):
                path.unlink()

    def test_unchecked_task_blocks(self):
        make_plan(self.feature, [("T-1", True), ("T-2", False)])
        make_log(self.feature, "t1-red", TS1, 1)
        make_log(self.feature, "t1-green", TS2, 0)
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("T-2", out)

    def test_missing_red_log_blocks(self):
        make_plan(self.feature, [("T-1", True)])
        make_log(self.feature, "t1-green", TS2, 0)
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("red", out)

    def test_red_log_with_exit_zero_blocks(self):
        make_plan(self.feature, [("T-1", True)])
        make_log(self.feature, "t1-red", TS1, 0)
        make_log(self.feature, "t1-green", TS2, 0)
        code, out = self.check()
        self.assertEqual(code, 1)

    def test_green_log_with_nonzero_exit_blocks(self):
        make_plan(self.feature, [("T-1", True)])
        make_log(self.feature, "t1-red", TS1, 1)
        make_log(self.feature, "t1-green", TS2, 2)
        code, _ = self.check()
        self.assertEqual(code, 1)

    def test_complete_red_green_passes(self):
        make_plan(self.feature, [("T-1", True), ("T-2", True)])
        make_log(self.feature, "t1-red", TS1, 1)
        make_log(self.feature, "t1-green", TS2, 0)
        make_log(self.feature, "t2-red", TS2, 1)
        make_log(self.feature, "t2-green", TS3, 0)
        code, out = self.check()
        self.assertEqual(code, 0, out)

    def test_verification_only_accepts_strict_run_envelope_without_red_green(self):
        (self.feature / "frame.md").write_text(
            "# 某特性 Frame\n\n- 意图: 测试用\n"
            "- 模式: 建造\n- 风险档位: 2\n- 档位理由: 测试\n"
            "- 用户可感知: 否\n- 理由: 仅验证门禁\n",
            encoding="utf-8",
        )
        (self.feature / "plan.md").write_text(
            "# 计划\n\n## 任务清单\n\n"
            "- [x] T-50 [verification-only] 运行既有验证\n",
            encoding="utf-8",
        )
        code, out = run_gate([
            "run", "--feature", str(self.feature), "--label", "t50-proof",
            "--", sys.executable, "-c", "print('verified')",
        ])
        self.assertEqual(code, 0, out)

        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("verification-only 机器证据", out)

    def test_verification_only_marker_requires_exact_ascii_token_boundaries(self):
        code, out = run_gate([
            "run", "--feature", str(self.feature), "--label", "t50-proof",
            "--", sys.executable, "-c", "print('verified')",
        ])
        self.assertEqual(code, 0, out)
        invalid_rests = [
            "  [verification-only] 描述",
            "\t[verification-only] 描述",
            " [Verification-only] 描述",
            " [VERIFICATION-ONLY] 描述",
            " [verification_only] 描述",
            " [verifiction-only] 描述",
            " [verification-only]suffix",
            " [verification-only]\t描述",
            " [verification-only]  描述",
            " [verification-only] ",
            " 描述 [verification-only]",
        ]
        for rest in invalid_rests:
            with self.subTest(rest=rest):
                self.write_task(rest)
                code, out = self.check()
                self.assertEqual(code, 1, out)
                self.assertIn("red", out)
                self.assertIn("green", out)

    def test_verification_only_marker_accepts_eol_or_single_space_description(self):
        code, out = run_gate([
            "run", "--feature", str(self.feature), "--label", "t50-proof",
            "--", sys.executable, "-c", "print('verified')",
        ])
        self.assertEqual(code, 0, out)
        for rest in (" [verification-only]", " [verification-only] 描述"):
            with self.subTest(rest=rest):
                self.write_task(rest)
                code, out = self.check()
                self.assertEqual(code, 0, out)
                self.assertIn("verification-only 机器证据", out)

    def test_verification_only_still_requires_task_done(self):
        self.write_task(" [verification-only] 描述", done=False)
        code, out = run_gate([
            "run", "--feature", str(self.feature), "--label", "t50-proof",
            "--", sys.executable, "-c", "print('verified')",
        ])
        self.assertEqual(code, 0, out)
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn("T-50", out)

    def test_verification_only_rejects_wrong_task_and_malformed_labels(self):
        self.write_task(" [verification-only] 描述")
        for label in (
            "t500-proof", "t50", "t50--proof", "task50-proof",
            "suite", "smoke", "demo",
        ):
            make_strict_log(self.feature, label, TS2, 0)
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn("verification-only", out)

    def test_verification_only_requires_at_least_one_exit_zero(self):
        self.write_task(" [verification-only] 描述")
        make_strict_log(self.feature, "t50-proof", TS2, 2)
        make_strict_log(self.feature, "t50-check", TS3, 1)
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn("exit 0", out)

    def test_verification_only_rejects_non_log_screenshot(self):
        self.write_task(" [verification-only] 描述")
        evidence = self.feature / "evidence"
        (evidence / "t50-proof.png").write_bytes(b"\x89PNG")
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn("verification-only", out)

    def test_verification_only_strict_envelope_rejects_each_malformed_field(self):
        self.write_task(" [verification-only] 描述")
        variants = {
            "bad-magic": {"magic": "# not-hf-gate-run"},
            "label-mismatch": {"header_label": "t50-other"},
            "empty-command": {"command": "   "},
            "naive-started": {"started": "2026-07-03T10:00:00"},
            "bad-started": {"started": "not-a-date"},
            "nonterminal-exit": {"suffix": "after exit\n"},
        }
        for name, kwargs in variants.items():
            with self.subTest(name=name):
                self.clear_t50_logs()
                make_strict_log(self.feature, f"t50-{name}", TS2, 0, **kwargs)
                code, out = self.check()
                self.assertEqual(code, 1, out)
                self.assertIn("strict run envelope", out)

    def test_verification_only_strict_envelope_rejects_missing_or_duplicate_headers(self):
        self.write_task(" [verification-only] 描述")
        valid_lines = [
            "# hf-gate-run",
            "# label: t50-proof",
            "# command: dummy",
            "# started: 2026-07-03T10:00:00Z",
            "out",
            "# exit: 0",
        ]
        cases = {
            "missing-label": [line for line in valid_lines if not line.startswith("# label:")],
            "missing-command": [line for line in valid_lines if not line.startswith("# command:")],
            "missing-started": [line for line in valid_lines if not line.startswith("# started:")],
            "missing-exit": [line for line in valid_lines if not line.startswith("# exit:")],
            "duplicate-label": valid_lines[:2] + [valid_lines[1]] + valid_lines[2:],
            "duplicate-command": valid_lines[:3] + [valid_lines[2]] + valid_lines[3:],
            "duplicate-started": valid_lines[:4] + [valid_lines[3]] + valid_lines[4:],
            "duplicate-exit": valid_lines + ["# exit: 0"],
            "noninteger-exit": valid_lines[:-1] + ["# exit: nope"],
        }
        for name, lines in cases.items():
            with self.subTest(name=name):
                self.clear_t50_logs()
                path = self.feature / "evidence" / f"t50-proof-{TS2}.log"
                path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                code, out = self.check()
                self.assertEqual(code, 1, out)
                self.assertIn("strict run envelope", out)

    def test_regular_tasks_reject_near_miss_red_green_labels(self):
        make_plan(self.feature, [("T-1", True)])
        for label, exit_code in (
            ("t1-redo", 1),
            ("t1-red-extra", 1),
            ("t1-greenish", 0),
            ("t1-green-extra", 0),
            ("t10-red", 1),
            ("t10-green", 0),
        ):
            make_log(self.feature, label, TS2, exit_code)
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn("t1-red-*.log", out)
        self.assertIn("t1-green-*.log", out)


class CheckShipTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.feature = Path(self._tmp.name) / "features" / "001-x"
        make_frame(self.feature, 2)
        make_log(self.feature, "baseline", TS1, 0)
        make_review(self.feature, "plan-review.md")
        make_plan(self.feature, [("T-1", True)])
        make_log(self.feature, "t1-red", TS1, 1)
        make_log(self.feature, "t1-green", TS2, 0)

    def tearDown(self):
        self._tmp.cleanup()

    def check(self):
        return run_gate(["check", "--feature", str(self.feature), "--to", "ship"])

    def complete(self):
        make_review(self.feature, "code-review.md")
        make_log(self.feature, "suite", TS3, 0)
        make_log(self.feature, "smoke", TS3, 0)

    def test_missing_code_review_blocks(self):
        make_log(self.feature, "suite", TS3, 0)
        make_log(self.feature, "smoke", TS3, 0)
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("code-review", out)

    def test_missing_suite_blocks(self):
        make_review(self.feature, "code-review.md")
        make_log(self.feature, "smoke", TS3, 0)
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("suite", out)

    def test_suite_older_than_green_blocks(self):
        self.complete()
        make_log(self.feature, "t1-green", TS3, 0)  # newer green than suite TS3? same ts ok
        make_log(self.feature, "t1-green", "20260703T130000Z", 0)
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("suite", out)

    def test_failed_suite_blocks(self):
        make_review(self.feature, "code-review.md")
        make_log(self.feature, "suite", TS3, 1)
        make_log(self.feature, "smoke", TS3, 0)
        code, _ = self.check()
        self.assertEqual(code, 1)

    def test_missing_smoke_blocks(self):
        make_review(self.feature, "code-review.md")
        make_log(self.feature, "suite", TS3, 0)
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("smoke", out)

    def test_smoke_screenshot_counts_as_evidence(self):
        make_review(self.feature, "code-review.md")
        make_log(self.feature, "suite", TS3, 0)
        (self.feature / "evidence" / "smoke-login-page.png").write_bytes(b"\x89PNG")
        code, out = self.check()
        self.assertEqual(code, 0, out)

    def test_complete_ship_passes(self):
        self.complete()
        code, out = self.check()
        self.assertEqual(code, 0, out)


class UsageTest(unittest.TestCase):
    def test_unknown_target_is_usage_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, _ = run_gate(["check", "--feature", tmp, "--to", "nonsense"])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

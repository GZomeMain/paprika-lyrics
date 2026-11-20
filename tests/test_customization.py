"""
Comprehensive test suite for Advanced Customization:
- Schema, OptionSpec, and CustomizationRegistry validation
- Built-in and user-defined preset lifecycle
- Merging, diffing, clamping, and default hydration
- Serialization, JSON envelope import/export, and schema migrations
- Thread-safe atomic storage persistence in CacheManager
- pywebview WindowApi bridge methods
"""

import copy
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

# Ensure external native/GUI dependencies are safely mocked if running in minimal test env
for _mod in [
    "webview",
    "webview.window",
    "requests",
    "winsdk",
    "winsdk.windows",
    "winsdk.windows.media",
    "winsdk.windows.media.control",
    "winsdk.windows.storage.streams",
]:
    if _mod not in sys.modules:
        _m = mock.MagicMock()
        if _mod == "webview.window":
            _m.FixPoint = mock.MagicMock()
            _m.FixPoint.NORTH = 1
            _m.FixPoint.WEST = 2
        sys.modules[_mod] = _m

import paprika_app
import storage
from core.customization import (
    CUSTOMIZATION_REGISTRY,
    CustomizationRegistry,
    OptionSpec,
    OptionType,
    Preset,
    SCHEMA_VERSION,
    is_valid_color,
    slugify,
)


class TestCustomizationRegistry(unittest.TestCase):
    """Tests registry schema, option specification, type validation, and coercion."""

    def setUp(self):
        self.registry = CustomizationRegistry()

    def test_canonical_domains_registered(self):
        domains = self.registry.get_domains()
        self.assertIn("lyrics", domains)
        self.assertIn("visuals", domains)
        self.assertIn("reactive", domains)
        self.assertIn("layout", domains)
        self.assertIn("themes", domains)
        self.assertEqual(len(domains), 5)

    def test_domain_metadata(self):
        meta = self.registry.get_domain_meta("lyrics")
        self.assertEqual(meta["id"], "lyrics")
        self.assertTrue(len(meta["label"]) > 0)
        self.assertIn("order", meta)

    def test_slugify(self):
        self.assertEqual(slugify("Neon Horizon 2026!"), "neon_horizon_2026")
        self.assertEqual(slugify("   --Custom Preset--  "), "custom_preset")
        self.assertEqual(slugify(""), "preset")

    def test_color_validation(self):
        valid_colors = [
            "#fff", "#0000", "#123456", "#12345678", "#AABBCC",
            "rgb(255, 0, 128)", "rgba(0, 0, 0, 0.5)",
            "hsl(120, 100%, 50%)", "hsla(240, 50%, 50%, 0.8)",
            "transparent", "white", "black", "red"
        ]
        for color in valid_colors:
            self.assertTrue(is_valid_color(color), f"Expected valid color: {color}")

        invalid_colors = ["not-a-color", "#12", "#12345", "rgb(255)", 123, None, ""]
        for bad in invalid_colors:
            self.assertFalse(is_valid_color(bad), f"Expected invalid color: {bad}")

    def test_validate_value_bool(self):
        spec = OptionSpec(domain="test", name="flag", type=OptionType.BOOL, default=False)
        self.assertEqual(self.registry.validate_value(spec, True)[1], True)
        self.assertEqual(self.registry.validate_value(spec, "yes")[1], True)
        self.assertEqual(self.registry.validate_value(spec, "1")[1], True)
        self.assertEqual(self.registry.validate_value(spec, "false")[1], False)
        self.assertEqual(self.registry.validate_value(spec, 0)[1], False)

    def test_validate_value_int_bounds_clamping(self):
        spec = OptionSpec(domain="test", name="count", type=OptionType.INT, default=50, bounds=(10, 100))
        # Within bounds
        valid, val, _ = self.registry.validate_value(spec, 42)
        self.assertTrue(valid)
        self.assertEqual(val, 42)

        # String coercion
        valid, val, _ = self.registry.validate_value(spec, "75")
        self.assertTrue(valid)
        self.assertEqual(val, 75)

        # Clamping
        _, val_clamped_low, _ = self.registry.validate_value(spec, -5, clamp_bounds=True)
        self.assertEqual(val_clamped_low, 10)
        _, val_clamped_high, _ = self.registry.validate_value(spec, 999, clamp_bounds=True)
        self.assertEqual(val_clamped_high, 100)

        # Without clamping
        valid, _, err = self.registry.validate_value(spec, 999, clamp_bounds=False)
        self.assertFalse(valid)
        self.assertIn("out of bounds", err)

    def test_validate_value_float_bounds(self):
        spec = OptionSpec(domain="test", name="scale", type=OptionType.FLOAT, default=1.0, bounds=(0.5, 3.0))
        valid, val, _ = self.registry.validate_value(spec, 2.5)
        self.assertTrue(valid)
        self.assertEqual(val, 2.5)

        valid, val, _ = self.registry.validate_value(spec, "1.75")
        self.assertTrue(valid)
        self.assertEqual(val, 1.75)

        _, clamped, _ = self.registry.validate_value(spec, 10.0, clamp_bounds=True)
        self.assertEqual(clamped, 3.0)

    def test_validate_value_enum(self):
        spec = OptionSpec(domain="test", name="mode", type=OptionType.ENUM, default="a", enum_values=["a", "b", "c"])
        valid, val, _ = self.registry.validate_value(spec, "b")
        self.assertTrue(valid)
        self.assertEqual(val, "b")

        valid, val, err = self.registry.validate_value(spec, "invalid_choice")
        self.assertFalse(valid)
        self.assertEqual(val, "a")
        self.assertIn("Invalid enum value", err)

    def test_validate_value_color(self):
        spec = OptionSpec(domain="test", name="tint", type=OptionType.COLOR, default="#ffffff")
        valid, val, _ = self.registry.validate_value(spec, "#ff0055")
        self.assertTrue(valid)
        self.assertEqual(val, "#ff0055")

        valid, val, err = self.registry.validate_value(spec, "junk")
        self.assertFalse(valid)
        self.assertEqual(val, "#ffffff")

    def test_validate_state_full(self):
        defaults = self.registry.get_defaults()
        defaults["lyrics"]["font_size_scale"] = 1.5
        defaults["visuals"]["particle_count"] = 100
        valid, clean_state, errors = self.registry.validate_state(defaults)
        self.assertTrue(valid)
        self.assertEqual(len(errors), 0)
        self.assertEqual(clean_state["lyrics"]["font_size_scale"], 1.5)
        self.assertEqual(clean_state["visuals"]["particle_count"], 100)

    def test_validate_state_clamps_out_of_range(self):
        bad_state = {
            "lyrics": {"font_size_scale": 99.0},
            "visuals": {"particle_count": -50},
        }
        valid, clean_state, _ = self.registry.validate_state(bad_state, clamp_bounds=True)
        self.assertTrue(valid)
        self.assertEqual(clean_state["lyrics"]["font_size_scale"], 3.0)
        self.assertEqual(clean_state["visuals"]["particle_count"], 0)

    def test_css_var_mappings(self):
        mappings = self.registry.get_css_var_mappings()
        self.assertIn("lyrics.font_size_scale", mappings)
        self.assertEqual(mappings["lyrics.font_size_scale"], "--cust-lyrics-font-size-scale")
        self.assertIn("visuals.particle_type", mappings)
        self.assertEqual(mappings["visuals.particle_type"], "--cust-particle-type")
        self.assertIn("reactive.pulse_strength", mappings)
        self.assertEqual(mappings["reactive.pulse_strength"], "--cust-pulse-strength")
        self.assertIn("layout.orientation", mappings)
        self.assertEqual(mappings["layout.orientation"], "--cust-layout-orientation")

    def test_phase3_new_options_schema(self):
        # Lyrics extensions
        lyr_opts = self.registry.get_domain_options("lyrics")
        self.assertIn("syllable_stretch_enabled", lyr_opts)
        self.assertEqual(lyr_opts["syllable_stretch_enabled"].default, True)
        self.assertIn("syllable_pop_enabled", lyr_opts)
        self.assertEqual(lyr_opts["syllable_pop_enabled"].default, True)
        self.assertIn("font_family_secondary", lyr_opts)
        self.assertEqual(lyr_opts["font_family_secondary"].default, "inherit")
        self.assertIn("font_family_adlib", lyr_opts)
        self.assertEqual(lyr_opts["font_family_adlib"].default, "inherit")
        self.assertIn("gradient_wipe_enabled", lyr_opts)
        self.assertEqual(lyr_opts["gradient_wipe_enabled"].default, True)
        self.assertIn("variable_font_weight_active", lyr_opts)
        self.assertEqual(lyr_opts["variable_font_weight_active"].bounds, (100, 900))
        self.assertEqual(lyr_opts["variable_font_weight_active"].default, 780)
        self.assertIn("variable_font_width_active", lyr_opts)
        self.assertEqual(lyr_opts["variable_font_width_active"].bounds, (50, 200))
        self.assertEqual(lyr_opts["variable_font_width_active"].default, 115)
        self.assertIn("scroll_inertia_mode", lyr_opts)
        self.assertEqual(lyr_opts["scroll_inertia_mode"].default, "springy")
        self.assertEqual(lyr_opts["scroll_inertia_mode"].enum_values, ["springy", "smooth", "subtle", "off"])
        self.assertEqual(lyr_opts["scroll_inertia_mode"].css_var, "--cust-scroll-inertia-mode")

        self.assertIn("secondary_scale", lyr_opts)
        self.assertEqual(lyr_opts["secondary_scale"].default, 0.75)
        self.assertEqual(lyr_opts["secondary_scale"].bounds, (0.40, 1.00))
        self.assertEqual(lyr_opts["secondary_scale"].css_var, "--cust-lyrics-secondary-scale")

        self.assertIn("adlib_scale", lyr_opts)
        self.assertEqual(lyr_opts["adlib_scale"].default, 0.70)
        self.assertEqual(lyr_opts["adlib_scale"].bounds, (0.40, 1.00))
        self.assertEqual(lyr_opts["adlib_scale"].css_var, "--cust-lyrics-adlib-scale")

        # Visuals extensions
        vis_opts = self.registry.get_domain_options("visuals")
        self.assertIn("breakdown_stasis_enabled", vis_opts)
        self.assertEqual(vis_opts["breakdown_stasis_enabled"].default, True)
        self.assertIn("aurora_mesh_enabled", vis_opts)
        self.assertEqual(vis_opts["aurora_mesh_enabled"].default, True)
        self.assertIn("visualizer_ribbon_enabled", vis_opts)
        self.assertEqual(vis_opts["visualizer_ribbon_enabled"].default, False)

        # Layout extensions
        lay_opts = self.registry.get_domain_options("layout")
        self.assertIn("orientation", lay_opts)
        self.assertEqual(lay_opts["orientation"].default, "horizontal")
        self.assertIn("lyrics_dock", lay_opts)
        self.assertEqual(lay_opts["lyrics_dock"].default, "center")
        self.assertIn("lyrics_offset_x", lay_opts)
        self.assertEqual(lay_opts["lyrics_offset_x"].bounds, (-500, 500))
        self.assertIn("lyrics_offset_y", lay_opts)
        self.assertEqual(lay_opts["lyrics_offset_y"].bounds, (-500, 500))
        self.assertIn("artwork_mode", lay_opts)
        self.assertEqual(lay_opts["artwork_mode"].default, "card")
        self.assertIn("artwork_shape", lay_opts)
        self.assertEqual(lay_opts["artwork_shape"].default, "rounded")
        self.assertIn("artwork_spin_enabled", lay_opts)
        self.assertEqual(lay_opts["artwork_spin_enabled"].default, False)
        self.assertIn("split_column_duet", lay_opts)
        self.assertEqual(lay_opts["split_column_duet"].default, False)
        self.assertIn("mini_ticker_mode", lay_opts)
        self.assertEqual(lay_opts["mini_ticker_mode"].default, False)

    def test_scroll_inertia_mode_validation(self):
        spec = self.registry.get_option("lyrics", "scroll_inertia_mode")
        self.assertIsNotNone(spec)
        valid, val, _ = self.registry.validate_value(spec, "smooth")
        self.assertTrue(valid)
        self.assertEqual(val, "smooth")

        valid, val, _ = self.registry.validate_value(spec, "invalid_mode")
        self.assertFalse(valid)
        self.assertEqual(val, "springy")

    def test_secondary_and_adlib_scale_validation(self):
        sec_spec = self.registry.get_option("lyrics", "secondary_scale")
        self.assertIsNotNone(sec_spec)
        valid, val, _ = self.registry.validate_value(sec_spec, 0.85)
        self.assertTrue(valid)
        self.assertEqual(val, 0.85)
        _, clamped_low, _ = self.registry.validate_value(sec_spec, 0.10, clamp_bounds=True)
        self.assertEqual(clamped_low, 0.40)
        _, clamped_high, _ = self.registry.validate_value(sec_spec, 1.50, clamp_bounds=True)
        self.assertEqual(clamped_high, 1.00)

        adlib_spec = self.registry.get_option("lyrics", "adlib_scale")
        self.assertIsNotNone(adlib_spec)
        valid, val, _ = self.registry.validate_value(adlib_spec, 0.65)
        self.assertTrue(valid)
        self.assertEqual(val, 0.65)
        _, clamped_low, _ = self.registry.validate_value(adlib_spec, -0.2, clamp_bounds=True)
        self.assertEqual(clamped_low, 0.40)
        _, clamped_high, _ = self.registry.validate_value(adlib_spec, 2.0, clamp_bounds=True)
        self.assertEqual(clamped_high, 1.00)

    def test_get_schema_structure(self):
        schema = self.registry.get_schema()
        self.assertEqual(schema["version"], SCHEMA_VERSION)
        self.assertEqual(len(schema["domains"]), 5)
        self.assertIn("css_variables", schema)


class TestDefaultsAndDiffing(unittest.TestCase):
    """Tests merging, diffing, and default state hydration."""

    def setUp(self):
        self.registry = CustomizationRegistry()

    def test_get_defaults_has_all_domains(self):
        defaults = self.registry.get_defaults()
        for domain in ["lyrics", "visuals", "reactive", "layout", "themes"]:
            self.assertIn(domain, defaults)
            self.assertTrue(len(defaults[domain]) > 0)

    def test_merge_with_defaults_sparse(self):
        sparse = {
            "lyrics": {"active_scale": 1.4},
            "themes": {"accent_color": "#00ffcc"},
        }
        merged = self.registry.merge_with_defaults(sparse)
        self.assertEqual(merged["lyrics"]["active_scale"], 1.4)
        self.assertEqual(merged["themes"]["accent_color"], "#00ffcc")
        # Untouched keys remain at schema default
        self.assertEqual(merged["lyrics"]["font_size_scale"], 1.0)
        self.assertEqual(merged["visuals"]["particle_type"], "motes")

    def test_merge_with_defaults_none(self):
        merged = self.registry.merge_with_defaults(None)
        self.assertEqual(merged, self.registry.get_defaults())

    def test_diff_with_defaults(self):
        state = copy.deepcopy(self.registry.get_defaults())
        state["lyrics"]["active_scale"] = 1.35
        state["reactive"]["pulse_strength"] = 2.5

        diff = self.registry.diff_with_defaults(state)
        self.assertEqual(diff, {
            "lyrics": {"active_scale": 1.35},
            "reactive": {"pulse_strength": 2.5},
        })


class TestPresetsLifecycle(unittest.TestCase):
    """Tests built-in presets and user-created preset lifecycle."""

    def setUp(self):
        self.registry = CustomizationRegistry()

    def test_builtin_presets_exist(self):
        builtins = self.registry.get_builtin_presets()
        expected = [
            "default", "minimalist", "cyberpunk", "ambient_neon", "kinetic_karaoke",
            "studio_oled", "apple_classical", "retro_arcade"
        ]
        for name in expected:
            self.assertIn(name, builtins, f"Missing preset {name}")
            preset = builtins[name]
            self.assertTrue(preset.builtin)
            self.assertEqual(preset.version, SCHEMA_VERSION)
            self.assertTrue(len(preset.state) > 0)

    def test_minimalist_preset_properties(self):
        p = self.registry.get_builtin_preset("minimalist")
        self.assertIsNotNone(p)
        self.assertEqual(p.state["visuals"]["particle_type"], "none")
        self.assertEqual(p.state["visuals"]["particle_count"], 0)
        self.assertEqual(p.state["lyrics"]["active_glow"], 0.0)

    def test_cyberpunk_preset_properties(self):
        p = self.registry.get_builtin_preset("cyberpunk")
        self.assertIsNotNone(p)
        self.assertEqual(p.state["lyrics"]["active_glow_color"], "#00ffcc")
        self.assertEqual(p.state["visuals"]["particle_type"], "stars")
        self.assertEqual(p.state["themes"]["accent_color"], "#00ffcc")

    def test_ambient_neon_preset_properties(self):
        p = self.registry.get_builtin_preset("ambient_neon")
        self.assertIsNotNone(p)
        self.assertEqual(p.state["visuals"]["particle_type"], "bokeh")
        self.assertEqual(p.state["visuals"]["background_blur"], 35.0)

    def test_kinetic_karaoke_preset_properties(self):
        p = self.registry.get_builtin_preset("kinetic_karaoke")
        self.assertIsNotNone(p)
        self.assertEqual(p.state["lyrics"]["active_scale"], 1.25)
        self.assertEqual(p.state["layout"]["lyrics_alignment"], "center")

    def test_studio_oled_preset_properties(self):
        p = self.registry.get_builtin_preset("studio_oled")
        self.assertIsNotNone(p)
        self.assertEqual(p.state["visuals"]["particle_type"], "none")
        self.assertEqual(p.state["visuals"]["background_dim"], 1.0)
        self.assertEqual(p.state["themes"]["accent_color"], "#ffffff")
        self.assertEqual(p.state["layout"]["artwork_shape"], "squircle")
        self.assertFalse(p.state["visuals"]["aurora_mesh_enabled"])

    def test_apple_classical_preset_properties(self):
        p = self.registry.get_builtin_preset("apple_classical")
        self.assertIsNotNone(p)
        self.assertEqual(p.state["themes"]["accent_color"], "#d4af37")
        self.assertEqual(p.state["visuals"]["particle_type"], "bokeh")
        self.assertEqual(p.state["layout"]["lyrics_alignment"], "center")
        self.assertEqual(p.state["lyrics"]["variable_font_weight_active"], 600)

    def test_retro_arcade_preset_properties(self):
        p = self.registry.get_builtin_preset("retro_arcade")
        self.assertIsNotNone(p)
        self.assertEqual(p.state["themes"]["accent_color"], "#ff007f")
        self.assertEqual(p.state["themes"]["glow_tint"], "#00f0ff")
        self.assertEqual(p.state["layout"]["artwork_shape"], "vinyl")
        self.assertFalse(p.state["layout"]["artwork_spin_enabled"])
        self.assertTrue(p.state["visuals"]["visualizer_ribbon_enabled"])
        self.assertTrue(p.state["lyrics"]["syllable_pop_enabled"])

    def test_artwork_spin_disabled_by_default_across_all_presets(self):
        for pid, preset in self.registry.get_builtin_presets().items():
            self.assertFalse(
                preset.state["layout"].get("artwork_spin_enabled", False),
                f"Preset {pid} should have artwork_spin_enabled=False"
            )

    def test_theme_bg_tint_across_all_presets(self):
        expected_tints = {
            "default": "rgba(140, 100, 255, 0.20)",
            "minimalist": "rgba(120, 140, 180, 0.12)",
            "cyberpunk": "rgba(180, 0, 255, 0.28)",
            "ambient_neon": "rgba(0, 245, 210, 0.25)",
            "kinetic_karaoke": "rgba(255, 50, 130, 0.22)",
            "studio_oled": "rgba(0, 0, 0, 0)",
            "apple_classical": "rgba(225, 165, 80, 0.24)",
            "retro_arcade": "rgba(30, 80, 240, 0.28)",
        }
        for pid, expected_tint in expected_tints.items():
            preset = self.registry.get_builtin_preset(pid)
            self.assertIsNotNone(preset)
            self.assertEqual(
                preset.state["themes"].get("theme_bg_tint"),
                expected_tint,
                f"Preset {pid} has unexpected theme_bg_tint"
            )

    def test_pulse_strength_calibrated_across_all_presets(self):
        expected_pulse = {
            "default": 0.38,
            "minimalist": 0.15,
            "cyberpunk": 0.48,
            "ambient_neon": 0.45,
            "kinetic_karaoke": 0.52,
            "studio_oled": 0.0,
            "apple_classical": 0.20,
            "retro_arcade": 0.48,
        }
        for pid, expected_val in expected_pulse.items():
            preset = self.registry.get_builtin_preset(pid)
            self.assertIsNotNone(preset)
            self.assertEqual(
                preset.state["reactive"].get("pulse_strength"),
                expected_val,
                f"Preset {pid} has unexpected pulse_strength"
            )

    def test_create_user_preset(self):
        preset = self.registry.create_preset(
            name="Neon Sunset",
            state={"themes": {"accent_color": "#ff5500"}},
            description="Warm orange ambient vibe",
        )
        self.assertFalse(preset.builtin)
        self.assertEqual(preset.name, "Neon Sunset")
        self.assertIn("user_neon_sunset", preset.id)
        self.assertEqual(preset.state["themes"]["accent_color"], "#ff5500")

    def test_list_presets_combined(self):
        user_p = {
            "user_synth": {
                "id": "user_synth",
                "name": "Synthwave",
                "builtin": False,
                "state": {},
            }
        }
        res = self.registry.list_presets(user_p)
        self.assertIn("builtin", res)
        self.assertIn("user", res)
        self.assertIn("presets", res)
        self.assertEqual(len(res["builtin"]), 8)
        self.assertEqual(len(res["user"]), 1)
        self.assertEqual(res["total"], 9)


class TestSerializationAndMigration(unittest.TestCase):
    """Tests JSON import, export, and schema migration."""

    def setUp(self):
        self.registry = CustomizationRegistry()

    def test_export_preset_json_envelope(self):
        preset = self.registry.get_builtin_preset("cyberpunk")
        json_str = self.registry.export_preset(preset)
        data = json.loads(json_str)
        self.assertEqual(data["$schema"], "paprika-customization-preset")
        self.assertEqual(data["schema_version"], SCHEMA_VERSION)
        self.assertIn("preset", data)
        self.assertEqual(data["preset"]["id"], "cyberpunk")

    def test_import_preset_envelope(self):
        export_payload = {
            "$schema": "paprika-customization-preset",
            "schema_version": 1,
            "preset": {
                "id": "future_retro",
                "name": "Future Retro",
                "description": "80s inspired retro look",
                "builtin": True,  # User import must override this to False
                "state": {
                    "themes": {"accent_color": "#ff00bb"},
                    "lyrics": {"font_size_scale": 1.2},
                },
            },
        }
        imported = self.registry.import_preset(json.dumps(export_payload))
        self.assertFalse(imported["builtin"])
        self.assertEqual(imported["name"], "Future Retro")
        self.assertEqual(imported["state"]["themes"]["accent_color"], "#ff00bb")
        self.assertEqual(imported["state"]["lyrics"]["font_size_scale"], 1.2)

    def test_import_preset_raw_format(self):
        raw_payload = {
            "name": "Simple Preset",
            "state": {"layout": {"lyrics_alignment": "center"}},
        }
        imported = self.registry.import_preset(json.dumps(raw_payload))
        self.assertFalse(imported["builtin"])
        self.assertEqual(imported["name"], "Simple Preset")
        self.assertEqual(imported["state"]["layout"]["lyrics_alignment"], "center")

    def test_import_invalid_json_raises(self):
        with self.assertRaises(ValueError):
            self.registry.import_preset("not valid json{")
        with self.assertRaises(ValueError):
            self.registry.import_preset("")

    def test_migration_pipeline(self):
        def v1_migration(data: dict) -> dict:
            # Simulated schema change: rename legacy 'old_glow' to 'active_glow'
            data["state"].setdefault("lyrics", {})
            if "old_glow" in data["state"]["lyrics"]:
                data["state"]["lyrics"]["active_glow"] = data["state"]["lyrics"].pop("old_glow")
            return data

        self.registry.register_migration(1, v1_migration)
        legacy_preset = {
            "name": "Legacy Preset",
            "version": 0,
            "state": {"lyrics": {"old_glow": 22.0}},
        }
        migrated = self.registry.migrate_preset(legacy_preset, from_version=0)
        self.assertEqual(migrated["version"], 1)
        self.assertEqual(migrated["state"]["lyrics"]["active_glow"], 22.0)
        self.assertNotIn("old_glow", migrated["state"]["lyrics"])


class TestStoragePersistence(unittest.TestCase):
    """Tests persistence in CacheManager without race conditions."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.path = Path(self.tmp_dir) / "cache.json"
        self.store = storage.CacheManager(filepath=self.path)

    def tearDown(self):
        try:
            self.store.flush()
        except Exception:
            pass
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_customization_state_persistence_roundtrip(self):
        test_state = {
            "lyrics": {"font_size_scale": 1.4, "active_scale": 1.15},
            "themes": {"accent_color": "#ff0055"},
        }
        self.store.save_customization_state(test_state, active_preset_id="cyberpunk")
        self.store.flush_sync()

        # Reload store from disk
        reloaded = storage.CacheManager(filepath=self.path)
        loaded_state = reloaded.get_customization_state()
        self.assertEqual(loaded_state["lyrics"]["font_size_scale"], 1.4)
        self.assertEqual(loaded_state["themes"]["accent_color"], "#ff0055")
        self.assertEqual(reloaded.get_customization_active_preset(), "cyberpunk")

    def test_custom_preset_lifecycle(self):
        preset_data = {
            "id": "my_preset_1",
            "name": "My Custom Preset",
            "builtin": False,
            "state": {"visuals": {"particle_count": 88}},
        }
        self.store.save_custom_preset("my_preset_1", preset_data)
        self.store.flush_sync()

        reloaded = storage.CacheManager(filepath=self.path)
        all_presets = reloaded.get_custom_presets()
        self.assertIn("my_preset_1", all_presets)
        self.assertEqual(all_presets["my_preset_1"]["name"], "My Custom Preset")

        # Delete preset
        deleted = reloaded.delete_custom_preset("my_preset_1")
        self.assertTrue(deleted)
        reloaded.flush_sync()

        fresh = storage.CacheManager(filepath=self.path)
        self.assertNotIn("my_preset_1", fresh.get_custom_presets())

    def test_thread_safe_concurrent_state_writes(self):
        threads = []
        errors = []

        def worker(idx):
            try:
                for j in range(15):
                    self.store.save_customization_state(
                        {"lyrics": {"font_size_scale": 1.0 + (idx * 0.1) + (j * 0.01)}},
                        active_preset_id=f"preset_{idx}",
                    )
            except Exception as exc:
                errors.append(exc)

        for i in range(5):
            t = threading.Thread(target=worker, args=(i,))
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        self.assertEqual(len(errors), 0)
        self.assertTrue(self.store.flush_sync())


class FakeWindow:
    def __init__(self):
        self.destroyed = False

    def destroy(self):
        self.destroyed = True

    def minimize(self):
        pass

    def resize(self, w, h, fix_point=None):
        pass


class TestWindowApiCustomization(unittest.TestCase):
    """Tests WindowApi customization methods."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.path = Path(self.tmp_dir) / "cache.json"
        self.test_store = storage.CacheManager(filepath=self.path)

        # Patch CACHE in paprika_app and storage to use our isolated test store
        self.patch_storage = mock.patch("storage.CACHE", self.test_store)
        self.patch_app_cache = mock.patch("paprika_app.CACHE", self.test_store)
        self.patch_storage.start()
        self.patch_app_cache.start()

        self.window = FakeWindow()
        self.api = paprika_app.WindowApi(self.window)

    def tearDown(self):
        self.patch_app_cache.stop()
        self.patch_storage.stop()
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_customization_get_state_initial(self):
        res = self.api.customization_get_state()
        self.assertTrue(res["success"])
        self.assertEqual(res["active_preset_id"], "default")
        self.assertIn("state", res)
        self.assertIn("lyrics", res["state"])
        self.assertEqual(res["state"]["lyrics"]["font_size_scale"], 1.0)
        # Direct top-level access supported
        self.assertEqual(res["lyrics"]["font_size_scale"], 1.0)

    def test_customization_save_state(self):
        update = {
            "lyrics": {"font_size_scale": 1.6},
            "themes": {"accent_color": "#00ffcc"},
            "active_preset_id": "custom",
        }
        saved = self.api.customization_save_state(update)
        self.assertTrue(saved)

        current = self.api.customization_get_state()
        self.assertEqual(current["state"]["lyrics"]["font_size_scale"], 1.6)
        self.assertEqual(current["state"]["themes"]["accent_color"], "#00ffcc")
        self.assertEqual(current["active_preset_id"], "custom")

    def test_customization_list_presets(self):
        presets = self.api.customization_list_presets()
        self.assertTrue(presets["success"])
        self.assertIn("builtin", presets)
        self.assertIn("user", presets)
        self.assertIn("presets", presets)
        self.assertGreaterEqual(len(presets["presets"]), 8)
        self.assertIn("studio_oled", presets["builtin"])
        self.assertIn("apple_classical", presets["builtin"])
        self.assertIn("retro_arcade", presets["builtin"])

    def test_customization_apply_preset_builtin(self):
        res = self.api.customization_apply_preset("cyberpunk")
        self.assertTrue(res["success"])
        self.assertEqual(res["preset_id"], "cyberpunk")
        self.assertEqual(res["state"]["themes"]["accent_color"], "#00ffcc")
        self.assertEqual(res["state"]["visuals"]["particle_type"], "stars")

        # Verify state in storage also changed
        current = self.api.customization_get_state()
        self.assertEqual(current["active_preset_id"], "cyberpunk")
        self.assertEqual(current["state"]["themes"]["accent_color"], "#00ffcc")

    def test_customization_apply_phase3_presets(self):
        # Studio OLED
        res = self.api.customization_apply_preset("studio_oled")
        self.assertTrue(res["success"])
        self.assertEqual(res["state"]["visuals"]["particle_type"], "none")
        self.assertEqual(res["state"]["layout"]["artwork_shape"], "squircle")
        self.assertEqual(res["state"]["themes"]["background_tint"], "#000000")

        # Apple Classical
        res = self.api.customization_apply_preset("apple_classical")
        self.assertTrue(res["success"])
        self.assertEqual(res["state"]["themes"]["accent_color"], "#d4af37")
        self.assertEqual(res["state"]["visuals"]["particle_type"], "bokeh")
        self.assertEqual(res["state"]["layout"]["lyrics_alignment"], "center")

        # Retro Arcade
        res = self.api.customization_apply_preset("retro_arcade")
        self.assertTrue(res["success"])
        self.assertEqual(res["state"]["themes"]["accent_color"], "#ff007f")
        self.assertEqual(res["state"]["layout"]["artwork_shape"], "vinyl")
        self.assertFalse(res["state"]["layout"]["artwork_spin_enabled"])
        self.assertTrue(res["state"]["visuals"]["visualizer_ribbon_enabled"])
        self.assertEqual(res["state"]["themes"]["theme_bg_tint"], "rgba(30, 80, 240, 0.28)")
        self.assertEqual(res["state"]["reactive"]["pulse_strength"], 0.48)

    def test_customization_apply_preset_invalid(self):
        res = self.api.customization_apply_preset("non_existent_preset_xyz")
        self.assertFalse(res["success"])
        self.assertIn("not found", res["error"])

    def test_customization_save_and_delete_user_preset(self):
        preset_state = {
            "lyrics": {"font_weight": 900},
            "visuals": {"particle_type": "ripples"},
        }
        saved = self.api.customization_save_preset("Party Mode", preset_state)
        self.assertTrue(saved)

        presets = self.api.customization_list_presets()
        user_presets = presets["user"]
        self.assertTrue(any(p["name"] == "Party Mode" for p in user_presets.values()))

        # Find the generated ID
        party_pid = next(pid for pid, p in user_presets.items() if p["name"] == "Party Mode")

        # Apply user preset
        applied = self.api.customization_apply_preset(party_pid)
        self.assertTrue(applied["success"])
        self.assertEqual(applied["state"]["lyrics"]["font_weight"], 900)

        # Delete user preset
        deleted = self.api.customization_delete_preset(party_pid)
        self.assertTrue(deleted)

        # Verify reverted active preset
        after_del = self.api.customization_get_state()
        self.assertEqual(after_del["active_preset_id"], "default")

    def test_customization_delete_preset_builtin_protected(self):
        # Cannot delete built-in presets
        res = self.api.customization_delete_preset("minimalist")
        self.assertFalse(res)

    def test_customization_export_preset(self):
        json_str = self.api.customization_export_preset("minimalist")
        self.assertTrue(len(json_str) > 0)
        data = json.loads(json_str)
        self.assertIn("preset", data)
        self.assertEqual(data["preset"]["id"], "minimalist")

    def test_customization_import_preset(self):
        payload = json.dumps({
            "$schema": "paprika-customization-preset",
            "schema_version": 1,
            "preset": {
                "name": "Emerald Dream",
                "state": {"themes": {"accent_color": "#00ff66"}},
            },
        })
        res = self.api.customization_import_preset(payload)
        self.assertTrue(res["success"])
        self.assertIn("preset_id", res)
        self.assertEqual(res["preset"]["name"], "Emerald Dream")

        # Can now apply imported preset
        applied = self.api.customization_apply_preset(res["preset_id"])
        self.assertTrue(applied["success"])
        self.assertEqual(applied["state"]["themes"]["accent_color"], "#00ff66")


if __name__ == "__main__":
    unittest.main()

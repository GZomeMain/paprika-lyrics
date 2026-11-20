"""
Advanced Customization Architecture for Paprika Lyrics.

⚠️ PRE-ALPHA / EXPERIMENTAL NOTICE:
This modular customization system is in active pre-alpha development and not
yet finalized for production. Schemas, options, and preset interfaces are
experimental and subject to change.

Provides a modular, extensible, and schema-driven customization engine:
- CustomizationRegistry: Domain and Option registration with type validation,
  bounds checking, defaults, css_var mapping, and tag metadata.
- Presets: Built-in aesthetic presets ('default', 'minimalist', 'cyberpunk',
  'ambient_neon', 'kinetic_karaoke') plus user-defined preset lifecycle.
- Serialization, schema validation, import/export (JSON), deep-merging with defaults,
  and migration pipeline.
"""

from __future__ import annotations

import copy
import json
import re
import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

SCHEMA_VERSION = 1

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_COLOR_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_COLOR_FUNC_RE = re.compile(r"^(rgba?|hsla?)\s*\([^\)]+\)$", re.IGNORECASE)
_NAMED_COLORS = {
    "transparent", "currentcolor", "inherit", "black", "white", "red", "green", "blue",
    "yellow", "cyan", "magenta", "gray", "grey", "orange", "purple", "pink", "violet"
}


def slugify(text: str) -> str:
    """Converts display text into a clean snake_case / kebab identifier."""
    if not text:
        return "preset"
    cleaned = _SLUG_RE.sub("_", text.strip().lower()).strip("_")
    return cleaned or "preset"


def is_valid_color(value: Any) -> bool:
    """Checks if a string represents a valid CSS color value."""
    if not isinstance(value, str):
        return False
    val = value.strip().lower()
    if not val:
        return False
    if val in _NAMED_COLORS:
        return True
    if _COLOR_HEX_RE.match(val):
        return True
    m = re.match(r"^(rgba?|hsla?)\s*\((.+)\)$", val)
    if m:
        parts = [p for p in re.split(r"[\s,/]+", m.group(2).strip()) if p]
        if len(parts) in (3, 4):
            return True
    return False


class OptionType(str, Enum):
    STRING = "string"
    INT = "int"
    FLOAT = "float"
    BOOL = "bool"
    COLOR = "color"
    ENUM = "enum"
    LIST = "list"
    DICT = "dict"


@dataclass
class OptionSpec:
    """
    Specification for a single customizable property.

    Attributes:
        domain: Namespace grouping (e.g. 'lyrics', 'visuals', 'reactive', 'layout', 'themes').
        name: Property identifier within the domain (e.g. 'font_size_scale').
        type: Data type requirement ('string', 'int', 'float', 'bool', 'color', 'enum', 'list', 'dict').
        default: Canonical default value.
        description: User-facing explanation of what this option affects.
        bounds: Optional (min, max) range for numeric types.
        enum_values: Optional list of permissible values for enum types.
        css_var: CSS custom property name (e.g. '--cust-lyrics-font-size-scale').
        tags: Categorization tags for filtering and indexing.
        validator: Optional custom predicate returning True if valid.
    """
    domain: str
    name: str
    type: OptionType | str
    default: Any
    description: str = ""
    bounds: Optional[Tuple[float, float]] = None
    enum_values: Optional[List[Any]] = None
    css_var: Optional[str] = None
    tags: List[str] = field(default_factory=list)
    validator: Optional[Callable[[Any], bool]] = None

    def __post_init__(self):
        if isinstance(self.type, str):
            try:
                self.type = OptionType(self.type.lower())
            except ValueError:
                self.type = OptionType.STRING
        if self.tags is None:
            self.tags = []

    def to_dict(self) -> dict:
        return {
            "domain": self.domain,
            "name": self.name,
            "type": self.type.value if isinstance(self.type, OptionType) else str(self.type),
            "default": self.default,
            "description": self.description,
            "bounds": list(self.bounds) if self.bounds else None,
            "enum_values": list(self.enum_values) if self.enum_values else None,
            "css_var": self.css_var,
            "tags": list(self.tags),
        }


@dataclass
class Preset:
    """
    Named configuration snapshot across one or more domains.
    """
    id: str
    name: str
    description: str = ""
    builtin: bool = False
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    author: str = "user"
    state: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    version: int = SCHEMA_VERSION

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "builtin": self.builtin,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "author": self.author,
            "state": copy.deepcopy(self.state),
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: dict) -> Preset:
        return cls(
            id=str(data.get("id", "")),
            name=str(data.get("name", "Untitled Preset")),
            description=str(data.get("description", "")),
            builtin=bool(data.get("builtin", False)),
            created_at=float(data.get("created_at", time.time())),
            updated_at=float(data.get("updated_at", time.time())),
            author=str(data.get("author", "user")),
            state=copy.deepcopy(data.get("state", {})),
            version=int(data.get("version", SCHEMA_VERSION)),
        )


class CustomizationRegistry:
    """
    Central registry for customization schema, options, validation, and presets.
    """

    def __init__(self):
        self._domains: Dict[str, Dict[str, OptionSpec]] = {}
        self._domain_meta: Dict[str, dict] = {}
        self._builtin_presets: Dict[str, Preset] = {}
        self._migration_handlers: Dict[int, Callable[[dict], dict]] = {}
        self._initialize_core_schema()
        self._initialize_builtin_presets()

    # =========================================================================
    # Domain & Option Registration
    # =========================================================================

    def register_domain(self, domain: str, label: str = "", description: str = "", order: int = 100):
        """Registers a customization domain namespace."""
        domain_key = domain.strip().lower()
        if domain_key not in self._domains:
            self._domains[domain_key] = {}
        self._domain_meta[domain_key] = {
            "id": domain_key,
            "label": label or domain_key.capitalize(),
            "description": description,
            "order": order,
        }

    def register_option(self, spec: OptionSpec):
        """Registers an option specification into its domain."""
        domain = spec.domain.strip().lower()
        if domain not in self._domains:
            self.register_domain(domain)
        self._domains[domain][spec.name] = spec

    def get_domains(self) -> List[str]:
        """Returns sorted list of registered domain keys."""
        return sorted(self._domains.keys(), key=lambda d: self._domain_meta.get(d, {}).get("order", 100))

    def get_domain_meta(self, domain: str) -> dict:
        """Returns metadata for a specific domain."""
        return dict(self._domain_meta.get(domain.strip().lower(), {}))

    def get_option(self, domain: str, name: str) -> Optional[OptionSpec]:
        """Retrieves a registered option spec by domain and name."""
        return self._domains.get(domain.strip().lower(), {}).get(name)

    def get_domain_options(self, domain: str) -> Dict[str, OptionSpec]:
        """Returns all option specs for a domain."""
        return dict(self._domains.get(domain.strip().lower(), {}))

    def get_all_options(self) -> Dict[str, Dict[str, OptionSpec]]:
        """Returns dictionary of all domains mapping to their option specs."""
        return {d: dict(opts) for d, opts in self._domains.items()}

    def get_schema(self) -> dict:
        """Serializes full registry schema for consumption by frontend or inspectors."""
        return {
            "version": SCHEMA_VERSION,
            "domains": [
                {
                    **self.get_domain_meta(d),
                    "options": [spec.to_dict() for spec in self._domains[d].values()],
                }
                for d in self.get_domains()
            ],
            "css_variables": self.get_css_var_mappings(),
        }

    def get_css_var_mappings(self) -> Dict[str, str]:
        """Returns map of 'domain.option_name' -> '--cust-...'."""
        mappings = {}
        for domain, opts in self._domains.items():
            for name, spec in opts.items():
                if spec.css_var:
                    mappings[f"{domain}.{name}"] = spec.css_var
        return mappings

    def get_defaults(self) -> Dict[str, Dict[str, Any]]:
        """Returns the complete nested dictionary of default option values."""
        defaults: Dict[str, Dict[str, Any]] = {}
        for domain, opts in self._domains.items():
            defaults[domain] = {name: copy.deepcopy(spec.default) for name, spec in opts.items()}
        return defaults

    # =========================================================================
    # Validation & Coercion
    # =========================================================================

    def validate_value(self, spec: OptionSpec, value: Any, clamp_bounds: bool = True) -> Tuple[bool, Any, Optional[str]]:
        """
        Validates and coerces a value against an OptionSpec.

        Returns:
            (is_valid, coerced_or_clamped_value, error_message)
        """
        opt_type = spec.type if isinstance(spec.type, OptionType) else OptionType(spec.type)

        try:
            if opt_type == OptionType.BOOL:
                if isinstance(value, str):
                    coerced = value.strip().lower() in ("true", "1", "yes", "on")
                else:
                    coerced = bool(value)
                return True, coerced, None

            elif opt_type == OptionType.INT:
                if isinstance(value, (int, float, str)):
                    coerced = int(round(float(value)))
                else:
                    return False, spec.default, f"Expected int for {spec.domain}.{spec.name}, got {type(value).__name__}"
                if spec.bounds:
                    min_val, max_val = int(spec.bounds[0]), int(spec.bounds[1])
                    if clamp_bounds:
                        coerced = max(min_val, min(max_val, coerced))
                    elif coerced < min_val or coerced > max_val:
                        return False, spec.default, f"{spec.domain}.{spec.name} ({coerced}) out of bounds [{min_val}, {max_val}]"
                return True, coerced, None

            elif opt_type == OptionType.FLOAT:
                if isinstance(value, (int, float, str)):
                    coerced = float(value)
                else:
                    return False, spec.default, f"Expected float for {spec.domain}.{spec.name}, got {type(value).__name__}"
                if spec.bounds:
                    min_val, max_val = float(spec.bounds[0]), float(spec.bounds[1])
                    if clamp_bounds:
                        coerced = max(min_val, min(max_val, coerced))
                    elif coerced < min_val or coerced > max_val:
                        return False, spec.default, f"{spec.domain}.{spec.name} ({coerced}) out of bounds [{min_val}, {max_val}]"
                return True, coerced, None

            elif opt_type == OptionType.COLOR:
                if not isinstance(value, str):
                    return False, spec.default, f"Expected string for color {spec.domain}.{spec.name}"
                if is_valid_color(value):
                    return True, value.strip(), None
                return False, spec.default, f"Invalid color format for {spec.domain}.{spec.name}: '{value}'"

            elif opt_type == OptionType.ENUM:
                val_str = str(value)
                if spec.enum_values and val_str in [str(e) for e in spec.enum_values]:
                    return True, val_str, None
                return False, spec.default, f"Invalid enum value '{value}' for {spec.domain}.{spec.name}; allowed: {spec.enum_values}"

            elif opt_type == OptionType.STRING:
                coerced = str(value) if value is not None else ""
                if spec.validator and not spec.validator(coerced):
                    return False, spec.default, f"Custom validation failed for {spec.domain}.{spec.name}"
                return True, coerced, None

            elif opt_type == OptionType.LIST:
                if isinstance(value, list):
                    return True, list(value), None
                return False, spec.default, f"Expected list for {spec.domain}.{spec.name}"

            elif opt_type == OptionType.DICT:
                if isinstance(value, dict):
                    return True, dict(value), None
                return False, spec.default, f"Expected dict for {spec.domain}.{spec.name}"

            return True, value, None

        except Exception as exc:
            return False, spec.default, f"Validation exception for {spec.domain}.{spec.name}: {exc}"

    def validate_state(
        self,
        state: dict,
        allow_partial: bool = True,
        clamp_bounds: bool = True,
    ) -> Tuple[bool, dict, List[str]]:
        """
        Validates an entire customization state dictionary.

        Returns:
            (is_valid, cleaned_state, error_messages)
        """
        if not isinstance(state, dict):
            return False, {}, ["State must be a dictionary."]

        # Unpack nested "state" key if passed from an envelope
        raw_state = state.get("state") if isinstance(state.get("state"), dict) else state

        clean_state: Dict[str, Dict[str, Any]] = {}
        errors: List[str] = []
        overall_valid = True

        for domain, domain_opts in self._domains.items():
            if domain in raw_state and isinstance(raw_state[domain], dict):
                clean_state[domain] = {}
                domain_input = raw_state[domain]

                for name, spec in domain_opts.items():
                    if name in domain_input:
                        val = domain_input[name]
                        valid, coerced, err = self.validate_value(spec, val, clamp_bounds=clamp_bounds)
                        clean_state[domain][name] = coerced
                        if not valid:
                            overall_valid = False
                            if err:
                                errors.append(err)
                    elif not allow_partial:
                        clean_state[domain][name] = copy.deepcopy(spec.default)
            elif not allow_partial:
                clean_state[domain] = {name: copy.deepcopy(spec.default) for name, spec in domain_opts.items()}

        # Keep any custom top-level keys or extensions if needed, but only return clean domains
        return overall_valid, clean_state, errors

    def merge_with_defaults(self, state: Optional[dict] = None) -> Dict[str, Dict[str, Any]]:
        """
        Deep merges a sparse or partial state onto the complete default schema.
        Guarantees that all domains and options are present and type-safe.
        """
        merged = self.get_defaults()
        if not state or not isinstance(state, dict):
            return merged

        # Unpack nested state if envelope was passed
        actual_state = state.get("state") if isinstance(state.get("state"), dict) else state

        for domain, domain_data in actual_state.items():
            if domain in self._domains and isinstance(domain_data, dict):
                for name, val in domain_data.items():
                    spec = self.get_option(domain, name)
                    if spec is not None:
                        _, coerced, _ = self.validate_value(spec, val, clamp_bounds=True)
                        merged[domain][name] = coerced

        return merged

    def diff_with_defaults(self, state: dict) -> Dict[str, Dict[str, Any]]:
        """
        Returns a sparse dictionary containing only options that differ from defaults.
        Useful for minimal preset storage and serialization.
        """
        defaults = self.get_defaults()
        diff: Dict[str, Dict[str, Any]] = {}

        if not isinstance(state, dict):
            return diff

        actual_state = state.get("state") if isinstance(state.get("state"), dict) else state

        for domain, domain_opts in self._domains.items():
            domain_diff = {}
            if domain in actual_state and isinstance(actual_state[domain], dict):
                for name, spec in domain_opts.items():
                    if name in actual_state[domain]:
                        val = actual_state[domain][name]
                        if val != defaults[domain].get(name):
                            domain_diff[name] = copy.deepcopy(val)
            if domain_diff:
                diff[domain] = domain_diff

        return diff

    # =========================================================================
    # Presets Lifecycle
    # =========================================================================

    def register_builtin_preset(self, preset: Preset):
        """Registers a read-only built-in preset."""
        preset.builtin = True
        self._builtin_presets[preset.id] = preset

    def get_builtin_preset(self, preset_id: str) -> Optional[Preset]:
        """Gets a built-in preset by id."""
        return self._builtin_presets.get(preset_id)

    def get_builtin_presets(self) -> Dict[str, Preset]:
        """Returns all registered built-in presets."""
        return dict(self._builtin_presets)

    def list_presets(self, user_presets: Optional[Dict[str, dict]] = None) -> dict:
        """
        Lists all available presets grouped by category and as a unified list.
        """
        builtin_dict = {pid: p.to_dict() for pid, p in self._builtin_presets.items()}
        user_dict: Dict[str, dict] = {}

        if user_presets and isinstance(user_presets, dict):
            for pid, pdata in user_presets.items():
                if isinstance(pdata, dict):
                    user_dict[pid] = dict(pdata)

        # Build combined list: built-ins first, then custom presets
        user_list = list(user_dict.values())
        all_presets = list(builtin_dict.values()) + user_list

        return {
            "builtin": builtin_dict,
            "user": user_dict,
            "user_presets": user_list,
            "custom_presets": user_list,
            "presets": all_presets,
            "total": len(all_presets),
        }

    def create_preset(
        self,
        name: str,
        state: dict,
        preset_id: Optional[str] = None,
        description: str = "",
        author: str = "user",
    ) -> Preset:
        """
        Creates and validates a new user Preset object.
        """
        clean_name = (name or "").strip() or "Untitled Preset"
        base_slug = slugify(clean_name)
        pid = preset_id or f"user_{base_slug}_{int(time.time())}"

        # Ensure ID doesn't collide with builtins
        if pid in self._builtin_presets:
            pid = f"user_{pid}"

        _, clean_state, _ = self.validate_state(state, allow_partial=True, clamp_bounds=True)

        now = time.time()
        return Preset(
            id=pid,
            name=clean_name,
            description=description,
            builtin=False,
            created_at=now,
            updated_at=now,
            author=author,
            state=clean_state,
            version=SCHEMA_VERSION,
        )

    # =========================================================================
    # Serialization, Import / Export & Migration
    # =========================================================================

    def export_preset(self, preset: Preset | dict) -> str:
        """
        Serializes a preset to a portable JSON envelope string.
        """
        preset_dict = preset.to_dict() if isinstance(preset, Preset) else dict(preset)

        envelope = {
            "$schema": "paprika-customization-preset",
            "schema_version": SCHEMA_VERSION,
            "exported_at": time.time(),
            "preset": preset_dict,
        }
        return json.dumps(envelope, indent=2)

    def import_preset(self, json_str: str) -> dict:
        """
        Parses, migrates, and validates an imported preset JSON string.

        Returns:
            Sanitized preset dictionary ready for storage.
        Raises:
            ValueError: If JSON is invalid or preset data is corrupted.
        """
        if not json_str or not isinstance(json_str, str):
            raise ValueError("Empty or non-string preset payload provided.")

        try:
            data = json.loads(json_str)
        except Exception as exc:
            raise ValueError(f"Invalid JSON string: {exc}")

        if not isinstance(data, dict):
            raise ValueError("Preset payload must be a JSON object.")

        # Check for envelope format
        if "preset" in data and isinstance(data["preset"], dict):
            incoming_ver = int(data.get("schema_version", 0))
            raw_preset = data["preset"]
        else:
            incoming_ver = int(data.get("version", data.get("schema_version", 0)))
            raw_preset = data

        # Run migration if payload is older
        migrated = self.migrate_preset(raw_preset, incoming_ver)

        # Validate structure
        name = str(migrated.get("name", "")).strip() or "Imported Preset"
        description = str(migrated.get("description", ""))
        state_dict = migrated.get("state", {})
        if not isinstance(state_dict, dict):
            state_dict = {}

        # Validate and coerce options
        _, clean_state, _ = self.validate_state(state_dict, allow_partial=True, clamp_bounds=True)

        # Generate unique user preset id
        base_id = str(migrated.get("id", "")).strip()
        if not base_id or base_id in self._builtin_presets:
            base_id = f"imported_{slugify(name)}_{int(time.time())}"

        now = time.time()
        final_preset = Preset(
            id=base_id,
            name=name,
            description=description,
            builtin=False,
            created_at=float(migrated.get("created_at", now)),
            updated_at=now,
            author=str(migrated.get("author", "imported")),
            state=clean_state,
            version=SCHEMA_VERSION,
        )

        return final_preset.to_dict()

    def register_migration(self, target_version: int, handler: Callable[[dict], dict]):
        """Registers a forward schema migration function."""
        self._migration_handlers[target_version] = handler

    def migrate_preset(self, preset_dict: dict, from_version: int) -> dict:
        """Applies version migrations forward to current SCHEMA_VERSION."""
        curr = copy.deepcopy(preset_dict)
        ver = from_version
        while ver < SCHEMA_VERSION:
            next_ver = ver + 1
            if next_ver in self._migration_handlers:
                curr = self._migration_handlers[next_ver](curr)
            ver = next_ver
        curr["version"] = SCHEMA_VERSION
        return curr

    # =========================================================================
    # Internal Schema & Presets Initialization
    # =========================================================================

    def _initialize_core_schema(self):
        """Populates the 5 canonical domains with comprehensive option specs."""

        # ---------------------------------------------------------------------
        # Domain: lyrics
        # ---------------------------------------------------------------------
        self.register_domain("lyrics", label="Lyrics & Typography", description="Syllable typography, active line scaling, and dynamic text effects", order=10)

        lyrics_opts = [
            OptionSpec(
                domain="lyrics",
                name="font_family",
                type=OptionType.STRING,
                default="",
                description="Custom font family name or CSS stack for lyrics",
                css_var="--cust-lyrics-font-family",
                tags=["typography", "font"],
            ),
            OptionSpec(
                domain="lyrics",
                name="font_size_scale",
                type=OptionType.FLOAT,
                default=1.0,
                bounds=(0.5, 3.0),
                description="Global typography scale multiplier",
                css_var="--cust-lyrics-font-size-scale",
                tags=["typography", "scale"],
            ),
            OptionSpec(
                domain="lyrics",
                name="font_weight",
                type=OptionType.INT,
                default=700,
                bounds=(100, 900),
                description="Lyrics font weight (100 to 900)",
                css_var="--cust-lyrics-font-weight",
                tags=["typography", "font"],
            ),
            OptionSpec(
                domain="lyrics",
                name="letter_spacing",
                type=OptionType.FLOAT,
                default=0.0,
                bounds=(-5.0, 20.0),
                description="Tracking / letter spacing in pixels",
                css_var="--cust-lyrics-letter-spacing",
                tags=["typography"],
            ),
            OptionSpec(
                domain="lyrics",
                name="active_scale",
                type=OptionType.FLOAT,
                default=1.08,
                bounds=(1.0, 2.0),
                description="Magnification scale of the currently singing line",
                css_var="--cust-lyrics-active-scale",
                tags=["typography", "animation"],
            ),
            OptionSpec(
                domain="lyrics",
                name="active_glow",
                type=OptionType.FLOAT,
                default=10.0,
                bounds=(0.0, 50.0),
                description="Bloom blur radius for the active singing line (0 = off)",
                css_var="--cust-lyrics-active-glow",
                tags=["typography", "glow"],
            ),
            OptionSpec(
                domain="lyrics",
                name="active_glow_color",
                type=OptionType.COLOR,
                default="rgba(255, 255, 255, 0.6)",
                description="Glow drop shadow color for active lyric line",
                css_var="--cust-lyrics-active-glow-color",
                tags=["typography", "color", "glow"],
            ),
            OptionSpec(
                domain="lyrics",
                name="line_gap",
                type=OptionType.FLOAT,
                default=18.0,
                bounds=(0.0, 100.0),
                description="Vertical gap spacing between lyric lines in pixels",
                css_var="--cust-lyrics-line-gap",
                tags=["layout", "spacing"],
            ),
            OptionSpec(
                domain="lyrics",
                name="inactive_opacity",
                type=OptionType.FLOAT,
                default=0.35,
                bounds=(0.0, 1.0),
                description="Opacity factor for upcoming or passed lyric lines",
                css_var="--cust-lyrics-inactive-opacity",
                tags=["typography"],
            ),
            OptionSpec(
                domain="lyrics",
                name="secondary_opacity",
                type=OptionType.FLOAT,
                default=0.5,
                bounds=(0.0, 1.0),
                description="Opacity for backing vocals and secondary lyric tiers",
                css_var="--cust-lyrics-secondary-opacity",
                tags=["typography"],
            ),
            OptionSpec(
                domain="lyrics",
                name="secondary_scale",
                type=OptionType.FLOAT,
                default=0.75,
                bounds=(0.40, 1.00),
                description="Font scale multiplier for secondary/backing vocals",
                css_var="--cust-lyrics-secondary-scale",
                tags=["typography", "scale"],
            ),
            OptionSpec(
                domain="lyrics",
                name="adlib_font_style",
                type=OptionType.ENUM,
                default="italic",
                enum_values=["normal", "italic", "oblique"],
                description="Font style for parenthetical ad-libs and harmonies",
                css_var="--cust-lyrics-adlib-style",
                tags=["typography"],
            ),
            OptionSpec(
                domain="lyrics",
                name="adlib_scale",
                type=OptionType.FLOAT,
                default=0.70,
                bounds=(0.40, 1.00),
                description="Font scale multiplier for ad-libs and short vocal asides",
                css_var="--cust-lyrics-adlib-scale",
                tags=["typography", "scale"],
            ),
            OptionSpec(
                domain="lyrics",
                name="bevel_effect",
                type=OptionType.BOOL,
                default=False,
                description="Enables sharp tactile bevel / embossing stroke on active lyrics",
                css_var="--cust-lyrics-bevel",
                tags=["typography", "effects"],
            ),
            OptionSpec(
                domain="lyrics",
                name="text_shadow",
                type=OptionType.STRING,
                default="",
                description="Custom CSS text-shadow rule override",
                css_var="--cust-lyrics-text-shadow",
                tags=["typography", "effects"],
            ),
            OptionSpec(
                domain="lyrics",
                name="syllable_stretch_enabled",
                type=OptionType.BOOL,
                default=True,
                description="Enable kinetic syllable stretching during sustained notes",
                css_var="--cust-lyrics-syllable-stretch",
                tags=["typography", "animation"],
            ),
            OptionSpec(
                domain="lyrics",
                name="syllable_pop_enabled",
                type=OptionType.BOOL,
                default=True,
                description="Trigger punchy scale pop transient on syllable activation",
                css_var="--cust-lyrics-syllable-pop",
                tags=["typography", "animation"],
            ),
            OptionSpec(
                domain="lyrics",
                name="font_family_secondary",
                type=OptionType.STRING,
                default="inherit",
                description="Custom font family for secondary/backing vocals",
                css_var="--cust-lyrics-font-family-secondary",
                tags=["typography", "font"],
            ),
            OptionSpec(
                domain="lyrics",
                name="font_family_adlib",
                type=OptionType.STRING,
                default="inherit",
                description="Custom font family for parenthetical ad-libs",
                css_var="--cust-lyrics-font-family-adlib",
                tags=["typography", "font"],
            ),
            OptionSpec(
                domain="lyrics",
                name="gradient_wipe_enabled",
                type=OptionType.BOOL,
                default=True,
                description="Smooth gradient fill sweep across singing syllables",
                css_var="--cust-lyrics-gradient-wipe",
                tags=["typography", "animation"],
            ),
            OptionSpec(
                domain="lyrics",
                name="variable_font_weight_active",
                type=OptionType.INT,
                default=780,
                bounds=(100, 900),
                description="Active lyric line variable font weight axis",
                css_var="--cust-lyrics-vf-weight-active",
                tags=["typography", "font"],
            ),
            OptionSpec(
                domain="lyrics",
                name="variable_font_width_active",
                type=OptionType.INT,
                default=115,
                bounds=(50, 200),
                description="Active lyric line variable font width/stretch axis",
                css_var="--cust-lyrics-vf-width-active",
                tags=["typography", "font"],
            ),
            OptionSpec(
                domain="lyrics",
                name="scroll_inertia_mode",
                type=OptionType.ENUM,
                default="springy",
                enum_values=["springy", "smooth", "subtle", "off"],
                description="Spring scroll animation and cascading inertia physics mode",
                css_var="--cust-scroll-inertia-mode",
                tags=["typography", "animation", "motion"],
            ),
        ]
        for opt in lyrics_opts:
            self.register_option(opt)

        # ---------------------------------------------------------------------
        # Domain: visuals
        # ---------------------------------------------------------------------
        self.register_domain("visuals", label="Visual Effects", description="Background atmosphere, particle systems, and canvas shaders", order=20)

        visuals_opts = [
            OptionSpec(
                domain="visuals",
                name="particle_type",
                type=OptionType.ENUM,
                default="motes",
                enum_values=["motes", "stars", "ripples", "bokeh", "none"],
                description="Pluggable atmospheric particle rendering style",
                css_var="--cust-particle-type",
                tags=["particles"],
            ),
            OptionSpec(
                domain="visuals",
                name="particle_count",
                type=OptionType.INT,
                default=60,
                bounds=(0, 500),
                description="Maximum number of active particles in emitter pool",
                css_var="--cust-particle-count",
                tags=["particles", "performance"],
            ),
            OptionSpec(
                domain="visuals",
                name="particle_speed",
                type=OptionType.FLOAT,
                default=1.0,
                bounds=(0.1, 5.0),
                description="Particle velocity multiplier",
                css_var="--cust-particle-speed",
                tags=["particles"],
            ),
            OptionSpec(
                domain="visuals",
                name="particle_size",
                type=OptionType.FLOAT,
                default=4.0,
                bounds=(1.0, 30.0),
                description="Particle base radius in pixels",
                css_var="--cust-particle-size",
                tags=["particles"],
            ),
            OptionSpec(
                domain="visuals",
                name="particle_color",
                type=OptionType.COLOR,
                default="rgba(255, 255, 255, 0.4)",
                description="Color / tint applied to atmospheric particles",
                css_var="--cust-particle-color",
                tags=["particles", "color"],
            ),
            OptionSpec(
                domain="visuals",
                name="particle_opacity",
                type=OptionType.FLOAT,
                default=0.6,
                bounds=(0.0, 1.0),
                description="Global particle canvas opacity",
                css_var="--cust-particle-opacity",
                tags=["particles"],
            ),
            OptionSpec(
                domain="visuals",
                name="background_blur",
                type=OptionType.FLOAT,
                default=20.0,
                bounds=(0.0, 100.0),
                description="Artwork backdrop gaussian blur in pixels",
                css_var="--cust-bg-blur",
                tags=["background"],
            ),
            OptionSpec(
                domain="visuals",
                name="background_dim",
                type=OptionType.FLOAT,
                default=0.4,
                bounds=(0.0, 1.0),
                description="Artwork backdrop dimming scrim opacity",
                css_var="--cust-bg-dim",
                tags=["background"],
            ),
            OptionSpec(
                domain="visuals",
                name="breakdown_stasis_enabled",
                type=OptionType.BOOL,
                default=True,
                description="Pause particle motion during musical breakdowns/pauses",
                css_var="--cust-visuals-breakdown-stasis",
                tags=["visuals", "beat"],
            ),
            OptionSpec(
                domain="visuals",
                name="aurora_mesh_enabled",
                type=OptionType.BOOL,
                default=True,
                description="Render dynamic ambient aurora mesh behind lyrics",
                css_var="--cust-visuals-aurora-mesh",
                tags=["visuals", "background"],
            ),
            OptionSpec(
                domain="visuals",
                name="visualizer_ribbon_enabled",
                type=OptionType.BOOL,
                default=False,
                description="Display bottom acoustic visualizer ribbon",
                css_var="--cust-visuals-visualizer-ribbon",
                tags=["visuals", "audio"],
            ),
        ]
        for opt in visuals_opts:
            self.register_option(opt)

        # ---------------------------------------------------------------------
        # Domain: reactive
        # ---------------------------------------------------------------------
        self.register_domain("reactive", label="Audio Reactive Sync", description="Beat-synced pulses, spring physics, and coordinated element motion", order=30)

        reactive_opts = [
            OptionSpec(
                domain="reactive",
                name="beat_sync_enabled",
                type=OptionType.BOOL,
                default=True,
                description="Master toggle for audio-reactive motion and beat impulses",
                css_var="--cust-beat-sync-enabled",
                tags=["audio", "beat"],
            ),
            OptionSpec(
                domain="reactive",
                name="pulse_strength",
                type=OptionType.FLOAT,
                default=0.38,
                bounds=(0.0, 3.0),
                description="Impulse amplitude multiplier on detected beats",
                css_var="--cust-pulse-strength",
                tags=["audio", "motion"],
            ),
            OptionSpec(
                domain="reactive",
                name="target_album_art",
                type=OptionType.BOOL,
                default=True,
                description="Album artwork card pulses on downbeats",
                css_var="--cust-reactive-target-art",
                tags=["targets"],
            ),
            OptionSpec(
                domain="reactive",
                name="target_lyrics_active",
                type=OptionType.BOOL,
                default=True,
                description="Active lyric line pulses and micro-tilts on downbeats",
                css_var="--cust-reactive-target-lyrics",
                tags=["targets"],
            ),
            OptionSpec(
                domain="reactive",
                name="target_controls",
                type=OptionType.BOOL,
                default=False,
                description="Playback controls react subtley to beat impulses",
                css_var="--cust-reactive-target-controls",
                tags=["targets"],
            ),
            OptionSpec(
                domain="reactive",
                name="target_ambient_bloom",
                type=OptionType.BOOL,
                default=True,
                description="Background ambient bloom flares synchronously on beats",
                css_var="--cust-reactive-target-bloom",
                tags=["targets"],
            ),
            OptionSpec(
                domain="reactive",
                name="target_particles",
                type=OptionType.BOOL,
                default=True,
                description="Particles scatter and surge velocity on transients",
                css_var="--cust-reactive-target-particles",
                tags=["targets"],
            ),
            OptionSpec(
                domain="reactive",
                name="response_action",
                type=OptionType.ENUM,
                default="scale",
                enum_values=["scale", "tilt", "glow", "chromatic", "all"],
                description="Primary kinetic response behavior on beat trigger",
                css_var="--cust-reactive-action",
                tags=["motion"],
            ),
            OptionSpec(
                domain="reactive",
                name="spring_damping",
                type=OptionType.FLOAT,
                default=0.7,
                bounds=(0.1, 1.0),
                description="Spring oscillation damping ratio (lower = bouncier)",
                css_var="--cust-spring-damping",
                tags=["motion", "physics"],
            ),
            OptionSpec(
                domain="reactive",
                name="sync_motion_mode",
                type=OptionType.ENUM,
                default="synchronized",
                enum_values=["synchronized", "alternating", "subtle", "off"],
                description="Multi-element coordination mode across UI surfaces",
                css_var="--cust-sync-motion-mode",
                tags=["motion"],
            ),
        ]
        for opt in reactive_opts:
            self.register_option(opt)

        # ---------------------------------------------------------------------
        # Domain: layout
        # ---------------------------------------------------------------------
        self.register_domain("layout", label="Interface & Layout", description="Lyrics alignment, container geometry, and UI component toggles", order=40)

        layout_opts = [
            OptionSpec(
                domain="layout",
                name="lyrics_alignment",
                type=OptionType.ENUM,
                default="left",
                enum_values=["left", "center", "right"],
                description="Horizontal text alignment for all lyric streams",
                css_var="--cust-lyrics-align",
                tags=["layout"],
            ),
            OptionSpec(
                domain="layout",
                name="container_padding",
                type=OptionType.INT,
                default=24,
                bounds=(0, 100),
                description="Inner padding around the lyrics container in pixels",
                css_var="--cust-container-padding",
                tags=["layout"],
            ),
            OptionSpec(
                domain="layout",
                name="sidebar_auto_hide",
                type=OptionType.BOOL,
                default=False,
                description="Automatically collapse navigation sidebar when lyrics are playing",
                css_var="--cust-sidebar-auto-hide",
                tags=["layout"],
            ),
            OptionSpec(
                domain="layout",
                name="show_album_art",
                type=OptionType.BOOL,
                default=True,
                description="Display album artwork thumbnail beside lyrics",
                css_var="--cust-show-album-art",
                tags=["layout"],
            ),
            OptionSpec(
                domain="layout",
                name="show_progress_bar",
                type=OptionType.BOOL,
                default=True,
                description="Show playback progress timeline bar",
                css_var="--cust-show-progress-bar",
                tags=["layout"],
            ),
            OptionSpec(
                domain="layout",
                name="compact_mode",
                type=OptionType.BOOL,
                default=False,
                description="Streamline interface for small overlay windows",
                css_var="--cust-compact-mode",
                tags=["layout"],
            ),
            OptionSpec(
                domain="layout",
                name="orientation",
                type=OptionType.ENUM,
                default="horizontal",
                enum_values=["horizontal", "vertical-right", "vertical-left", "vertical-column"],
                description="Overall overlay window orientation mode",
                css_var="--cust-layout-orientation",
                tags=["layout"],
            ),
            OptionSpec(
                domain="layout",
                name="lyrics_dock",
                type=OptionType.ENUM,
                default="center",
                enum_values=["center", "left", "right", "top", "bottom"],
                description="Dock anchor position for lyrics container",
                css_var="--cust-lyrics-dock",
                tags=["layout"],
            ),
            OptionSpec(
                domain="layout",
                name="lyrics_offset_x",
                type=OptionType.INT,
                default=0,
                bounds=(-500, 500),
                description="Horizontal lyrics container position offset in pixels",
                css_var="--cust-lyrics-offset-x",
                tags=["layout", "geometry"],
            ),
            OptionSpec(
                domain="layout",
                name="lyrics_offset_y",
                type=OptionType.INT,
                default=0,
                bounds=(-500, 500),
                description="Vertical lyrics container position offset in pixels",
                css_var="--cust-lyrics-offset-y",
                tags=["layout", "geometry"],
            ),
            OptionSpec(
                domain="layout",
                name="artwork_mode",
                type=OptionType.ENUM,
                default="card",
                enum_values=["card", "vinyl", "silhouette", "hidden"],
                description="Album artwork rendering representation",
                css_var="--cust-artwork-mode",
                tags=["layout", "artwork"],
            ),
            OptionSpec(
                domain="layout",
                name="artwork_shape",
                type=OptionType.ENUM,
                default="rounded",
                enum_values=["rounded", "circle", "squircle", "diamond", "pill", "vinyl"],
                description="Geometric silhouette mask for album artwork",
                css_var="--cust-artwork-shape",
                tags=["layout", "artwork"],
            ),
            OptionSpec(
                domain="layout",
                name="artwork_spin_enabled",
                type=OptionType.BOOL,
                default=False,
                description="Continuous rotation animation for album artwork",
                css_var="--cust-artwork-spin",
                tags=["layout", "artwork", "animation"],
            ),
            OptionSpec(
                domain="layout",
                name="split_column_duet",
                type=OptionType.BOOL,
                default=False,
                description="Split multi-singer/duet lyrics into parallel columns",
                css_var="--cust-split-column-duet",
                tags=["layout"],
            ),
            OptionSpec(
                domain="layout",
                name="mini_ticker_mode",
                type=OptionType.BOOL,
                default=False,
                description="Compact single-line horizontal ticker layout",
                css_var="--cust-mini-ticker-mode",
                tags=["layout"],
            ),
        ]
        for opt in layout_opts:
            self.register_option(opt)

        # ---------------------------------------------------------------------
        # Domain: themes
        # ---------------------------------------------------------------------
        self.register_domain("themes", label="Color & Themes", description="Accent palette, background tints, and dynamic artwork color matching", order=50)

        themes_opts = [
            OptionSpec(
                domain="themes",
                name="accent_color",
                type=OptionType.COLOR,
                default="#ff3366",
                description="Primary interactive accent color",
                css_var="--cust-accent-color",
                tags=["theme", "color"],
            ),
            OptionSpec(
                domain="themes",
                name="background_tint",
                type=OptionType.COLOR,
                default="#0a0a0c",
                description="Deep background tint applied under translucent surfaces",
                css_var="--cust-bg-tint",
                tags=["theme", "color"],
            ),
            OptionSpec(
                domain="themes",
                name="glow_tint",
                type=OptionType.COLOR,
                default="#ff3366",
                description="Color used for ambient lighting and bloom halos",
                css_var="--cust-glow-tint",
                tags=["theme", "color"],
            ),
            OptionSpec(
                domain="themes",
                name="color_mode",
                type=OptionType.ENUM,
                default="artwork_adaptive",
                enum_values=["artwork_adaptive", "custom", "monochrome", "vibrant"],
                description="Color generation mode for UI accents and ambient bloom",
                css_var="--cust-color-mode",
                tags=["theme"],
            ),
            OptionSpec(
                domain="themes",
                name="theme_bg_tint",
                type=OptionType.COLOR,
                default="rgba(140, 100, 255, 0.20)",
                description="Atmospheric theme background hue tint",
                css_var="--cust-theme-bg-tint",
                tags=["theme", "color", "background"],
            ),
        ]
        for opt in themes_opts:
            self.register_option(opt)

    def _initialize_builtin_presets(self):
        """Initializes canonical built-in presets."""
        defaults = self.get_defaults()

        # 1. Default
        self.register_builtin_preset(
            Preset(
                id="default",
                name="Default",
                description="Standard balanced Paprika visual styling and typography",
                builtin=True,
                author="Paprika",
                state=copy.deepcopy(defaults),
            )
        )

        # 2. Minimalist
        min_state = copy.deepcopy(defaults)
        min_state["lyrics"].update({
            "font_size_scale": 1.0,
            "font_weight": 500,
            "active_scale": 1.02,
            "active_glow": 0.0,
            "line_gap": 14.0,
        })
        min_state["visuals"].update({
            "particle_type": "none",
            "particle_count": 0,
            "background_blur": 0.0,
            "background_dim": 0.6,
        })
        min_state["reactive"].update({
            "pulse_strength": 0.15,
            "response_action": "scale",
            "spring_damping": 0.9,
        })
        min_state["layout"].update({
            "lyrics_alignment": "left",
            "show_album_art": False,
            "artwork_spin_enabled": False,
        })
        min_state["themes"].update({
            "color_mode": "monochrome",
            "accent_color": "#ffffff",
            "theme_bg_tint": "rgba(120, 140, 180, 0.12)",
        })
        self.register_builtin_preset(
            Preset(
                id="minimalist",
                name="Minimalist",
                description="Distraction-free, crisp typography with particles disabled and calm motion",
                builtin=True,
                author="Paprika",
                state=min_state,
            )
        )

        # 3. Cyberpunk
        cyber_state = copy.deepcopy(defaults)
        cyber_state["lyrics"].update({
            "font_size_scale": 1.15,
            "font_weight": 800,
            "active_scale": 1.15,
            "active_glow": 25.0,
            "active_glow_color": "#00ffcc",
            "bevel_effect": True,
            "letter_spacing": 1.5,
        })
        cyber_state["visuals"].update({
            "particle_type": "stars",
            "particle_count": 120,
            "particle_speed": 2.0,
            "particle_color": "#ff0055",
            "particle_opacity": 0.85,
        })
        cyber_state["reactive"].update({
            "pulse_strength": 0.48,
            "response_action": "chromatic",
            "target_controls": True,
            "spring_damping": 0.5,
        })
        cyber_state["layout"].update({
            "artwork_spin_enabled": False,
        })
        cyber_state["themes"].update({
            "accent_color": "#00ffcc",
            "glow_tint": "#ff0055",
            "background_tint": "#080812",
            "color_mode": "custom",
            "theme_bg_tint": "rgba(180, 0, 255, 0.28)",
        })
        self.register_builtin_preset(
            Preset(
                id="cyberpunk",
                name="Cyberpunk",
                description="Neon-drenched high contrast with chromatic bursts and energetic star particles",
                builtin=True,
                author="Paprika",
                state=cyber_state,
            )
        )

        # 4. Ambient Neon
        ambient_state = copy.deepcopy(defaults)
        ambient_state["lyrics"].update({
            "font_size_scale": 1.05,
            "font_weight": 600,
            "active_scale": 1.1,
            "active_glow": 20.0,
            "active_glow_color": "#bd00ff",
            "line_gap": 22.0,
        })
        ambient_state["visuals"].update({
            "particle_type": "bokeh",
            "particle_count": 45,
            "particle_speed": 0.7,
            "particle_size": 12.0,
            "particle_color": "rgba(189, 0, 255, 0.45)",
            "background_blur": 35.0,
        })
        ambient_state["reactive"].update({
            "pulse_strength": 0.45,
            "response_action": "glow",
            "spring_damping": 0.8,
        })
        ambient_state["layout"].update({
            "artwork_spin_enabled": False,
        })
        ambient_state["themes"].update({
            "accent_color": "#bd00ff",
            "glow_tint": "#7000ff",
            "color_mode": "artwork_adaptive",
            "theme_bg_tint": "rgba(0, 245, 210, 0.25)",
        })
        self.register_builtin_preset(
            Preset(
                id="ambient_neon",
                name="Ambient Neon",
                description="Lush, dreamy glow with floating bokeh particles and fluid spring dynamics",
                builtin=True,
                author="Paprika",
                state=ambient_state,
            )
        )

        # 5. Kinetic Karaoke
        karaoke_state = copy.deepcopy(defaults)
        karaoke_state["lyrics"].update({
            "font_size_scale": 1.25,
            "font_weight": 800,
            "active_scale": 1.25,
            "active_glow": 15.0,
            "active_glow_color": "#ffbb00",
            "line_gap": 24.0,
        })
        karaoke_state["visuals"].update({
            "particle_type": "ripples",
            "particle_count": 80,
            "particle_speed": 1.4,
            "particle_color": "#ffbb00",
        })
        karaoke_state["reactive"].update({
            "pulse_strength": 0.52,
            "response_action": "scale",
            "target_album_art": True,
            "target_lyrics_active": True,
            "spring_damping": 0.6,
            "sync_motion_mode": "synchronized",
        })
        karaoke_state["layout"].update({
            "lyrics_alignment": "center",
            "artwork_spin_enabled": False,
        })
        karaoke_state["themes"].update({
            "accent_color": "#ffbb00",
            "glow_tint": "#ff5500",
            "color_mode": "vibrant",
            "theme_bg_tint": "rgba(255, 50, 130, 0.22)",
        })
        self.register_builtin_preset(
            Preset(
                id="kinetic_karaoke",
                name="Kinetic Karaoke",
                description="Energetic, punchy lyrics scaling and heavy beat synchronization for singing along",
                builtin=True,
                author="Paprika",
                state=karaoke_state,
            )
        )

        # 6. Studio OLED
        oled_state = copy.deepcopy(defaults)
        oled_state["lyrics"].update({
            "font_size_scale": 1.0,
            "font_weight": 600,
            "active_scale": 1.05,
            "active_glow": 6.0,
            "active_glow_color": "rgba(255, 255, 255, 0.4)",
            "variable_font_weight_active": 700,
            "variable_font_width_active": 100,
            "line_gap": 16.0,
        })
        oled_state["visuals"].update({
            "particle_type": "none",
            "particle_count": 0,
            "background_blur": 0.0,
            "background_dim": 1.0,
            "aurora_mesh_enabled": False,
        })
        oled_state["reactive"].update({
            "pulse_strength": 0.0,
            "response_action": "scale",
            "spring_damping": 0.85,
        })
        oled_state["layout"].update({
            "artwork_mode": "card",
            "artwork_shape": "squircle",
            "artwork_spin_enabled": False,
        })
        oled_state["themes"].update({
            "accent_color": "#ffffff",
            "background_tint": "#000000",
            "glow_tint": "#ffffff",
            "color_mode": "monochrome",
            "theme_bg_tint": "rgba(0, 0, 0, 0)",
        })
        self.register_builtin_preset(
            Preset(
                id="studio_oled",
                name="Studio OLED",
                description="Ultra-pure dark backdrop, crisp monochrome typography, and zero particle distraction",
                builtin=True,
                author="Paprika",
                state=oled_state,
            )
        )

        # 7. Apple Classical
        classical_state = copy.deepcopy(defaults)
        classical_state["lyrics"].update({
            "font_size_scale": 1.05,
            "font_weight": 500,
            "active_scale": 1.04,
            "active_glow": 8.0,
            "active_glow_color": "rgba(212, 175, 55, 0.5)",
            "adlib_font_style": "italic",
            "variable_font_weight_active": 600,
            "variable_font_width_active": 105,
            "line_gap": 20.0,
        })
        classical_state["visuals"].update({
            "particle_type": "bokeh",
            "particle_count": 30,
            "particle_speed": 0.5,
            "particle_size": 8.0,
            "particle_color": "rgba(212, 175, 55, 0.3)",
            "background_blur": 40.0,
            "aurora_mesh_enabled": True,
        })
        classical_state["reactive"].update({
            "pulse_strength": 0.20,
            "response_action": "glow",
            "spring_damping": 0.85,
            "sync_motion_mode": "subtle",
        })
        classical_state["layout"].update({
            "lyrics_alignment": "center",
            "artwork_shape": "squircle",
            "artwork_mode": "card",
            "artwork_spin_enabled": False,
        })
        classical_state["themes"].update({
            "accent_color": "#d4af37",
            "background_tint": "#12100e",
            "glow_tint": "#e6ca65",
            "color_mode": "custom",
            "theme_bg_tint": "rgba(225, 165, 80, 0.24)",
        })
        self.register_builtin_preset(
            Preset(
                id="apple_classical",
                name="Apple Classical",
                description="Refined editorial typography, warm gold accents, and serene ambient dynamics",
                builtin=True,
                author="Paprika",
                state=classical_state,
            )
        )

        # 8. Retro Arcade
        arcade_state = copy.deepcopy(defaults)
        arcade_state["lyrics"].update({
            "font_size_scale": 1.18,
            "font_weight": 800,
            "active_scale": 1.18,
            "active_glow": 20.0,
            "active_glow_color": "#00f0ff",
            "bevel_effect": True,
            "syllable_pop_enabled": True,
            "variable_font_weight_active": 850,
            "variable_font_width_active": 125,
            "line_gap": 22.0,
        })
        arcade_state["visuals"].update({
            "particle_type": "stars",
            "particle_count": 140,
            "particle_speed": 2.2,
            "particle_color": "#00f0ff",
            "aurora_mesh_enabled": True,
            "visualizer_ribbon_enabled": True,
        })
        arcade_state["reactive"].update({
            "pulse_strength": 0.48,
            "response_action": "all",
            "target_controls": True,
            "spring_damping": 0.55,
            "sync_motion_mode": "synchronized",
        })
        arcade_state["layout"].update({
            "artwork_shape": "vinyl",
            "artwork_mode": "vinyl",
            "artwork_spin_enabled": False,
        })
        arcade_state["themes"].update({
            "accent_color": "#ff007f",
            "glow_tint": "#00f0ff",
            "background_tint": "#0b001a",
            "color_mode": "vibrant",
            "theme_bg_tint": "rgba(30, 80, 240, 0.28)",
        })
        self.register_builtin_preset(
            Preset(
                id="retro_arcade",
                name="Retro Arcade",
                description="Electrifying arcade nostalgia with starfield bursts, spinning vinyl art, and audio visualizer ribbon",
                builtin=True,
                author="Paprika",
                state=arcade_state,
            )
        )


# Global singleton registry instance
CUSTOMIZATION_REGISTRY = CustomizationRegistry()

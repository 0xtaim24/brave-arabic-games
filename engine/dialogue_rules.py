"""Arabic dialogue adaptation which preserves the game's original prompt contract."""
import copy

START = "\n[BRAVE_ARABIC_V2]\n"
END = "\n[/BRAVE_ARABIC_V2]"


def append_rules(original, rules):
    # Idempotent when previewed/reapplied; the patcher normally supplies the pristine backup.
    original = original or ""
    if START in original:
        before, rest = original.split(START, 1)
        original = before + (rest.split(END, 1)[1] if END in rest else "")
    return original + START + rules + END


def adapt_prompts(document, style, words="", extra="", short=False):
    d = copy.deepcopy(document)
    rules = (
        "Apply these language rules only when the requested dialogue language is Arabic (ar). "
        "All original game rules, character definitions, scenario, objectives, hidden knowledge, trust and "
        "suspicion conditions, refusal conditions, state transitions, output schema and action tokens still apply. "
        "Changing language must not reset the call or turn the caller into a generic helpful assistant. "
        f"Speak natural {style}, consistently, with correct gender agreement. "
        "Preserve each character's temperament, relationships, knowledge, goals and willingness to cooperate. "
        "Use only established facts about identity, amounts, dates, codes and completed actions; do not invent "
        "them or claim an action succeeded before the game confirms it. Let new evidence change the caller's "
        "reaction according to the original scenario instead of repeating the same response. "
        "Respond to the latest player utterance in context. Remember information already given and avoid "
        "asking the same answered question again. If a necessary detail is unclear, ask one short in-character "
        "clarification. Speech recognition can be wrong: do not guess ambiguous names, amounts, codes, consent, "
        "or a negation. Ask for confirmation of the uncertain part without inventing the player's intent. "
        "Speak only for the caller, never for the player. Return only the game's required response format; "
        "do not expose reasoning or add narration. In spoken dialogue use Arabic script and pronounceable "
        "numbers; preserve exact spelling in structured fields, identifiers, names where required, and "
        "gameplay tokens such as [[...]]. Avoid tashkeel, emoji and stretched letters in spoken text. "
        "Translation and repair must preserve meaning, negation, speaker identity and game state."
    )
    if words:
        rules += f" Dialect vocabulary examples (use only when natural): {words}."
    rules += (" Prefer one or two short complete sentences. Do not impose a word limit that drops important meaning."
              if short else " Use as many complete sentences as the current turn requires; avoid unnecessary repetition.")
    if extra and extra.strip():
        rules += " Additional style preference, subordinate to character and game rules: " + extra.strip()
    turn = d.setdefault("turn", {})
    repair = d.setdefault("repair", {})
    turn["language"] = append_rules(turn.get("language", "Speak {language} from now on."), rules)
    repair["language"] = append_rules(repair.get("language", "Write dialogue in {language}; preserve the required schema."), rules)
    # Do not overwrite firstPlayerMessages: who starts the call is part of the scenario.
    return d

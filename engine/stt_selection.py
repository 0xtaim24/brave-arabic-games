"""Select among measured models without pretending one synthetic clip proves dialect accuracy."""
RANK = {"tiny": 1, "base": 2, "small": 3, "medium": 4, "qwen-ar-light": 4.5, "large-v3-turbo": 5, "cohere-ar-q5": 6, "cohere-ar-q8": 7}


def is_conversational(result):
    return result.get('short_seconds', result.get('seconds', 99)) <= 2.5 and result.get('rtf', 99) <= .55


def choose_model(measured):
    valid = {k: v for k, v in measured.items() if v.get("seconds", 0) > 0 and v.get("audio_s", 0) > 0}
    if not valid:
        raise ValueError("No successful recognition benchmark")
    # Both absolute response time and real-time factor matter for a conversation.
    fast = {k: v for k, v in valid.items() if is_conversational(v)}
    if fast:
        best_error = min(v.get("cer", 1) for v in fast.values())
        close = {k: v for k, v in fast.items() if v.get("cer", 1) <= best_error + 0.025}
        pick = max(close, key=lambda k: (RANK.get(k, 0), -close[k]["seconds"]))
        return pick, "Selected from measured local models; verify accuracy using your own microphone."
    pick = min(valid, key=lambda k: valid[k]["seconds"])
    return pick, "All tested models exceeded the conversation latency target; this is the fastest tested option."

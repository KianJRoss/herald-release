"""Adapter implementation declarations, independent of account health and probe evidence."""

def backend_capabilities(backend):
    cli = backend.config.get('cli_name') if backend.backend_type == 'cli' else None
    known_cli = cli in {'codex','claude','antigravity'}
    resume = ('implemented' if cli in {'codex','claude'} else
              'unsupported' if cli == 'antigravity' or backend.backend_type != 'cli' else 'unknown')
    return {
        'schema_version': 1,
        'backend': backend.name,
        'available': bool(backend.enabled and not backend.circuit_open),
        'source': 'adapter_implementation',
        'native_resume': {'support': resume, 'verification': 'not_probed'},
        'portable_handoff': {'support': resume, 'verification': 'not_probed'},
        'streaming_events': {'support': 'implemented' if known_cli else 'unknown', 'verification': 'not_probed'},
    }

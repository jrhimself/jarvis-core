# Architecture

How the pieces of JARVIS fit together, in diagrams. The prose lives in the
the [README](../README.md); this page is the map.
Running it -- deploy paths, credentials, state and schedules -- has its own page in
[operations.md](operations.md).

## System overview

```mermaid
flowchart TB
    subgraph browser["Browser — HUD"]
        mic(["microphone"])
        speaker(["speaker"])
        canvas["display canvas: orb, transcript,<br/>images, sensor panels, charts"]
    end

    subgraph host["The machine it runs on"]
        subgraph brain["brain (Node 22)"]
            https["HTTPS static server<br/>(TLS: mic needs a secure origin)"]
            ws["websocket (ws.ts)"]
            conv["Conversation<br/>(session idle & turn limits)"]
            agent["AgentSession<br/>Claude Agent SDK, sonnet,<br/>persistent between turns"]
            stt["Scribe STT<br/>(ElevenLabs, streaming partials)"]
            tts["TTS (ElevenLabs or Fish Audio)<br/>sentence by sentence,<br/>'say' path skips the model"]
            subgraph core["core servers (in-process MCP)"]
                display["display"]
                memtools["memory"]
                insight["insight (proactive)"]
            end
            loader["pack loader<br/>scan, per-call timeout"]
            subgraph packs["packs/* (in-process MCP, none of them in this repo)"]
                hapack["hass<br/>read · act · agenda"]
                weather["weather"]
                gmail["gmail"]
                localpacks["whatever else you installed"]
            end
            provider["HomeProvider<br/>(HA adapter + capabilities)"]
            proactive["proactive watcher<br/>baselines, rules, anomalies"]
            memory[("memory.db<br/>SQLite + embeddings")]
        end
    end

    ha["The house<br/>(Home Assistant)"]
    eleven["ElevenLabs API"]
    fish["Fish Audio API"]
    outside["whatever a pack talks to"]

    mic -->|audio stream| ws
    ws -->|text + audio| speaker
    ws --> canvas
    browser <-->|wss| ws
    ws --> conv --> agent
    agent --- core
    agent --- packs
    loader --> packs
    stt --> conv
    agent --> tts --> ws
    stt <--> eleven
    tts <--> eleven
    tts <--> fish
    hapack <--> ha
    localpacks --> outside
    proactive --> provider --> ha
    proactive --> memory
    memtools --> memory
```

A deployment may also have helpers that talk to the house directly, without going
through the brain at all — scheduled tasks on a workstation, say, that follow its
lock state. They cost no tokens and keep working while the brain is down. Those
live outside this repository, as packs of their own under `packs/`.

## A voice turn

```mermaid
sequenceDiagram
    autonumber
    actor U as You
    participant H as HUD (browser)
    participant W as ws.ts
    participant S as Scribe (STT)
    participant C as Conversation
    participant A as AgentSession
    participant T as TTS

    U->>H: speak
    H->>W: PCM audio stream
    W->>S: forward audio
    S-->>W: partial text (live on the HUD)
    Note over S,W: silence timer closes the phrase
    S->>C: settled text
    C->>A: ask(text) — primed with facts<br/>the question already reaches for
    A-->>W: text fragments as they are thought
    A->>A: tool calls (house state, memory,<br/>display, confirmations)
    W->>T: completed sentences
    T-->>H: audio, sentence by sentence
    H->>U: JARVIS speaks while still thinking
```

## Spoken confirmation — two turns, always

Anything that secures the house -- locks, alarm, door openers -- uses this
two-step contract, and so does every private pack that guards something. The
model cannot fake a turn boundary: the pending action records the turn it was
proposed in, and the confirming call must arrive in a **later** turn. The state
lives in the closure the pack's `create` returned, so it dies with the
conversation it was asked in.

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Pending: propose (turn n)<br/>action registered with askedInTurn = n
    Pending --> Pending: execute in same turn n<br/>→ refused
    Pending --> Executed: execute (turn n+1)<br/>instruction matches + confirmed = true
    Pending --> Idle: user declines / topic changes /<br/>session ends (pending cleared)
    Executed --> [*]
```

## Memory pipeline

```mermaid
flowchart LR
    turn["every finished turn<br/>(question, answer, tool calls)"] --> log["turn log<br/>(memory.db)"]
    log --> distil["distiller<br/>cheaper model, runs when<br/>the conversation is over"]
    distil --> facts["facts, preferences, habits"]
    facts --> prime["priming: facts a question<br/>already reaches for are sent<br/>along with it — no tool round trip"]
    prime --> agentx["AgentSession"]
    facts --> consolidate["consolidation<br/>(systemd timer)"]
    log --> corpus["corpus export<br/>(systemd timer)"]
    facts --> backup["backups<br/>(systemd timer, JARVIS_BACKUP_KEEP)"]
```

## Deploy and operations

The host is the source of truth; GitHub is downstream. Pushing to GitHub does
**not** deploy.

```mermaid
flowchart LR
    dev["working copy"] -->|git push host main| host["host bare repo"]
    host --> hook["post-receive hook:<br/>build, test, restart"]
    hook --> svc["jarvis-brain.service"]
    host -->|forwards| gh["GitHub"]
    timers["systemd timers:<br/>backup · consolidate ·<br/>corpus · cert-renew"] --> svc
```


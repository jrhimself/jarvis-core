# Example seeds

What a first memory can be given, in the shape `memory/import-cli.ts` reads.
Copy these to `config/seeds/`, replace every line with something true about your
own household, and run:

```
node brain/dist/memory/import-cli.js
```

Each file is a JSON array of facts. Four fields:

| field | what it is |
| --- | --- |
| `kind` | one of `voorkeur`, `feit`, `persoon`, `gewoonte`, `conclusie`, `lopend` |
| `subject` | a short label, unique per kind; re-importing updates the fact with the same one |
| `body` | one or two sentences, in the language JARVIS speaks |
| `core` | `true` puts it in every prompt. Reserve it for what is always relevant: who lives here, and how they want to be spoken to |

Files are read in name order, which is why they are numbered. Importing is safe
to repeat: a fact upserts on its subject and kind.

Seed what a person would have to be told and a tool cannot be asked. Anything
Home Assistant already measures does not belong here -- it is out of date the
moment it is written, and JARVIS can simply look.

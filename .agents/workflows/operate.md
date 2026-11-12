---
title: Operate a system
arguments: []
modes:
  - slug: default
    title: Operate
    entry: Do all writes target a non-production system?
    steps:
      - frame
      - investigate
      - confirm-write
      - act
      - close
  - slug: production
    title: Operate on production
    entry: Does any write target production?
    steps:
      - frame
      - investigate
      - confirm-production-write
      - act
      - close
---
Carry out a bounded operation through the system's tools. Every write is framed, investigated, and confirmed before it is made.

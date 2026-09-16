---
description: Module boundaries, service shape, validation, errors, and code ceilings
always: true
---

# Code structure

## A module is one concern

A module owns one concern, states what it knows and must not know, and is reached only through its exported service or schemas. `scripts/check-architecture.ts` enforces declared module boundaries.

## Imports point one way

Imports follow the declared layer direction. Break cycles with explicit ports rather than upward imports. `scripts/check-architecture.ts` enforces import boundaries and cycles.

## Separate decisions from adapters

Express policy as a pure function over plain values, with no database handle, process, clock, or environment access. An adapter gathers facts and applies the ruling. This separation is enforced by review.

## Keep the engine ignorant

Durable execution knows generic job identity, state, deadlines, retries, and suspension on input. Contracts decide what forces suspension, and routing owns failover. `scripts/check-architecture.ts` enforces the engine boundary.

## Evidence only consumes

Scoring, routing, and review consume execution records; execution never reads their conclusions. `scripts/check-architecture.ts` enforces the evidence boundary.

## Validate once at the edge

Validate input where it enters through a command, tool, procedure, or file read. Inside the module, use the resulting types without re-validating them. This rule is enforced by review.

## Keep surfaces thin and services thick

A command, tool, or procedure validates, authorises, and calls its service. Queries, decisions, and transactions belong to the service. This rule is enforced by review.

## Keep transactions whole

A write transaction or lock ordering is the smallest unit that may move. The module that opens it owns every write inside it. This rule is enforced by review.

## Errors carry the remedy

A refusal names the condition it could not establish and the command or edit that clears it. It never reports emptiness for data it could not see. This rule is enforced by review.

## Respect the file ceiling

A production or test file at the ceiling may only shrink. Split out and name another concern when a file needs more room. `scripts/check-file-ceiling.ts` owns and enforces the ceiling and frozen-file ratchet.

## Respect the complexity ceiling

A function at the cognitive complexity ceiling may only become simpler. Extract a decision when a function needs more complexity. The cognitive complexity rule in `eslint.config.js` owns the ceiling, and `scripts/check-cognitive-ceiling.ts` enforces the frozen-function ratchet.

## Remove dead code

Dead code fails the gate. The baseline only shrinks; `scripts/check-dead-code.ts` enforces it.

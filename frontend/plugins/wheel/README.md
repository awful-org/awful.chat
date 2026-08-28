# Wheel decide

Spin a wheel to settle what to play. One spin per wheel: the first spin in
message order wins, later spins are no-ops, and every client computes the
same winner (verifiable and consistent for everyone; not adversarially
fair, the spinner influences the seed).

## Usage

```
/wheel Valorant, CS2, Deep Rock
/wheel What are we playing? Valorant, CS2, Deep Rock
```

Anyone in the room can hit Spin once. The wheel animates onto the winner;
scrolling back to a decided wheel shows the result without replaying.

## Install

Built in: ships with every awful.chat instance, nothing to configure.
Toggle per user in Settings > Plugins.

## Instance requirements

None.

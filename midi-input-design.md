# MIDI Controller Input for Tidal MCP Server

## Overview
Enable MIDI controllers to control Tidal patterns, effects, and performance parameters through the MCP server, allowing physical knobs, faders, and pads to manipulate live coding sessions.

## Core Implementation

### MIDI Input Handler
```typescript
import { WebMidi } from 'webmidi';

class MIDIInputManager {
  private inputs: Map<string, WebMidi.Input> = new Map();
  private mappings: Map<string, MIDIMapping> = new Map();
  private learnMode: boolean = false;
  private lastMIDIEvent: MIDIEvent | null = null;

  interface MIDIMapping {
    // Source (MIDI)
    device: string;
    type: 'cc' | 'note' | 'pitch' | 'aftertouch' | 'program';
    channel: number;
    number: number; // CC number or note number

    // Target (Tidal)
    target: MappingTarget;

    // Transform
    range: [number, number];
    curve: 'linear' | 'exponential' | 'logarithmic' | 'stepped';
    steps?: number; // For stepped curves
    invert?: boolean;
  }

  interface MappingTarget {
    type: 'pattern' | 'effect' | 'global' | 'trigger' | 'macro';
    channel?: string; // d1, d2, etc.
    parameter?: string; // gain, pan, speed, etc.
    pattern?: string; // Pattern to trigger
    action?: string; // Custom action
  }

  async initialize() {
    await WebMidi.enable();

    WebMidi.inputs.forEach(input => {
      this.connectInput(input);
    });

    // Hot-plug support
    WebMidi.addListener("connected", (e) => {
      if (e.port.type === "input") {
        this.connectInput(e.port as WebMidi.Input);
      }
    });
  }

  private connectInput(input: WebMidi.Input) {
    this.inputs.set(input.id, input);

    // Listen to all MIDI messages
    input.addListener('controlchange', 'all', (e) => {
      this.handleCC(input.id, e);
    });

    input.addListener('noteon', 'all', (e) => {
      this.handleNoteOn(input.id, e);
    });

    input.addListener('noteoff', 'all', (e) => {
      this.handleNoteOff(input.id, e);
    });

    input.addListener('pitchbend', 'all', (e) => {
      this.handlePitchBend(input.id, e);
    });
  }
}
```

### Control Change Mappings
```typescript
class CCMapper {
  // Map CC to Tidal parameters
  private handleCC(device: string, event: ControlChangeEvent) {
    const mappingKey = `${device}:cc:${event.channel}:${event.controller}`;
    const mapping = this.mappings.get(mappingKey);

    if (this.learnMode) {
      this.lastMIDIEvent = {
        device,
        type: 'cc',
        channel: event.channel,
        number: event.controller,
        value: event.value
      };
      return;
    }

    if (!mapping) return;

    const value = this.transformValue(event.value, mapping);

    switch (mapping.target.type) {
      case 'effect':
        this.applyEffect(mapping.target, value);
        break;
      case 'pattern':
        this.modifyPattern(mapping.target, value);
        break;
      case 'global':
        this.setGlobal(mapping.target, value);
        break;
      case 'macro':
        this.executeMacro(mapping.target, value);
        break;
    }
  }

  private applyEffect(target: MappingTarget, value: number) {
    const { channel, parameter } = target;

    // Generate Tidal code based on the parameter
    let tidalCode = '';

    switch (parameter) {
      case 'gain':
        tidalCode = `${channel} $ (# gain ${value})`;
        break;
      case 'pan':
        tidalCode = `${channel} $ (# pan ${value})`;
        break;
      case 'speed':
        tidalCode = `${channel} $ (# speed ${value})`;
        break;
      case 'cutoff':
        tidalCode = `${channel} $ (# cutoff ${value})`;
        break;
      case 'resonance':
        tidalCode = `${channel} $ (# resonance ${value})`;
        break;
      case 'delay':
        tidalCode = `${channel} $ (# delay ${value})`;
        break;
      case 'room':
        tidalCode = `${channel} $ (# room ${value})`;
        break;
      case 'size':
        tidalCode = `${channel} $ (# size ${value})`;
        break;
    }

    // Send to Tidal
    this.sendToTidal(tidalCode);
  }

  private modifyPattern(target: MappingTarget, value: number) {
    // Modify pattern density, subdivision, etc.
    const { channel } = target;

    // Example: Control pattern density with a knob
    const density = Math.floor(value * 16) + 1; // 1-16 hits
    const pattern = `sound "bd*${density}"`;

    this.sendToTidal(`${channel} $ ${pattern}`);
  }
}
```

### Note/Pad Mappings
```typescript
class NotePadMapper {
  private notePatterns: Map<number, PatternTrigger> = new Map();
  private chordMode: boolean = false;
  private activeNotes: Set<number> = new Set();

  interface PatternTrigger {
    type: 'pattern' | 'sample' | 'function' | 'scene';
    content: string;
    channel?: string;
    toggle?: boolean; // Toggle on/off vs momentary
    exclusive?: boolean; // Mutes other patterns in group
    group?: string; // Exclusivity group
  }

  // Map MIDI notes to patterns/samples
  setupDefaultMappings() {
    // Drum pads (typically notes 36-51 on pad controllers)
    this.notePatterns.set(36, {
      type: 'pattern',
      content: 'sound "bd bd ~ bd"',
      channel: 'd1',
      toggle: true
    });

    this.notePatterns.set(37, {
      type: 'pattern',
      content: 'sound "~ sn ~ sn"',
      channel: 'd2',
      toggle: true
    });

    this.notePatterns.set(38, {
      type: 'pattern',
      content: 'sound "hh*8"',
      channel: 'd3',
      toggle: true
    });

    // Scene triggers (higher notes)
    this.notePatterns.set(60, {
      type: 'scene',
      content: 'minimal',
      exclusive: true,
      group: 'scenes'
    });

    this.notePatterns.set(61, {
      type: 'scene',
      content: 'buildup',
      exclusive: true,
      group: 'scenes'
    });

    this.notePatterns.set(62, {
      type: 'scene',
      content: 'drop',
      exclusive: true,
      group: 'scenes'
    });
  }

  handleNoteOn(device: string, event: NoteEvent) {
    const trigger = this.notePatterns.get(event.note);
    if (!trigger) return;

    this.activeNotes.add(event.note);

    if (trigger.toggle) {
      this.togglePattern(trigger);
    } else {
      this.activatePattern(trigger);
    }

    // Handle exclusive groups
    if (trigger.exclusive && trigger.group) {
      this.muteOthersInGroup(trigger.group, event.note);
    }
  }

  handleNoteOff(device: string, event: NoteEvent) {
    this.activeNotes.delete(event.note);

    const trigger = this.notePatterns.get(event.note);
    if (!trigger || trigger.toggle) return;

    // Momentary mode - stop when released
    this.deactivatePattern(trigger);
  }

  // Chord detection for harmonic patterns
  detectChord(): string | null {
    if (this.activeNotes.size < 3) return null;

    const notes = Array.from(this.activeNotes).sort((a, b) => a - b);
    const intervals = notes.map(n => n % 12);

    // Simple chord detection
    if (this.isChord(intervals, [0, 4, 7])) return 'major';
    if (this.isChord(intervals, [0, 3, 7])) return 'minor';
    if (this.isChord(intervals, [0, 4, 7, 11])) return 'maj7';
    if (this.isChord(intervals, [0, 3, 7, 10])) return 'min7';

    return null;
  }
}
```

### Macro Controls
```typescript
class MacroController {
  private macros: Map<string, Macro> = new Map();

  interface Macro {
    name: string;
    parameters: MacroParameter[];
    interpolate: boolean;
  }

  interface MacroParameter {
    target: string; // e.g., "d1.speed", "d2.gain"
    min: number;
    max: number;
    curve: string;
  }

  // Complex multi-parameter control with one knob
  createFilterSweepMacro() {
    this.macros.set('filter_sweep', {
      name: 'Filter Sweep',
      parameters: [
        {
          target: 'd1.cutoff',
          min: 200,
          max: 10000,
          curve: 'exponential'
        },
        {
          target: 'd1.resonance',
          min: 0,
          max: 0.9,
          curve: 'linear'
        },
        {
          target: 'd2.cutoff',
          min: 500,
          max: 8000,
          curve: 'exponential'
        }
      ],
      interpolate: true
    });
  }

  applyMacro(macroName: string, value: number) {
    const macro = this.macros.get(macroName);
    if (!macro) return;

    const tidalCommands: string[] = [];

    macro.parameters.forEach(param => {
      const [channel, effect] = param.target.split('.');
      const mappedValue = this.interpolate(
        value,
        param.min,
        param.max,
        param.curve
      );

      tidalCommands.push(
        `${channel} $ (# ${effect} ${mappedValue})`
      );
    });

    // Send all commands together
    this.sendToTidal(tidalCommands.join('\n'));
  }
}
```

### MIDI Learn Mode
```typescript
class MIDILearnMode {
  private learning: boolean = false;
  private targetParameter: MappingTarget | null = null;
  private onLearnComplete: ((mapping: MIDIMapping) => void) | null = null;

  startLearning(target: MappingTarget): Promise<MIDIMapping> {
    this.learning = true;
    this.targetParameter = target;

    console.log(`MIDI Learn: Move a control to map to ${target.parameter}`);

    return new Promise((resolve) => {
      this.onLearnComplete = (mapping) => {
        this.learning = false;
        this.targetParameter = null;
        resolve(mapping);
      };

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.learning) {
          this.cancelLearning();
          reject(new Error('MIDI learn timeout'));
        }
      }, 10000);
    });
  }

  handleMIDIInput(event: MIDIEvent) {
    if (!this.learning || !this.targetParameter) return;

    // Create mapping from the received MIDI event
    const mapping: MIDIMapping = {
      device: event.device,
      type: event.type,
      channel: event.channel,
      number: event.number,
      target: this.targetParameter,
      range: [0, 1],
      curve: 'linear'
    };

    // Auto-detect appropriate range based on parameter
    if (this.targetParameter.parameter === 'cutoff') {
      mapping.range = [200, 10000];
      mapping.curve = 'exponential';
    } else if (this.targetParameter.parameter === 'gain') {
      mapping.range = [0, 1.5];
    }

    this.saveMapping(mapping);
    this.onLearnComplete?.(mapping);
  }
}
```

### Performance Features
```typescript
class PerformanceMode {
  private banks: Map<number, Bank> = new Map();
  private currentBank: number = 0;
  private snapshots: Snapshot[] = [];

  interface Bank {
    id: number;
    name: string;
    mappings: MIDIMapping[];
    color: string;
  }

  interface Snapshot {
    id: string;
    name: string;
    timestamp: number;
    state: {
      channels: Map<string, string>;
      effects: Map<string, any>;
      tempo: number;
    };
  }

  // Bank switching for different sections of a performance
  switchBank(bankId: number) {
    this.currentBank = bankId;
    const bank = this.banks.get(bankId);

    if (bank) {
      this.loadMappings(bank.mappings);
      this.updateControllerLEDs(bank.color);
    }
  }

  // Snapshot current state for later recall
  takeSnapshot(name: string): Snapshot {
    const snapshot: Snapshot = {
      id: generateId(),
      name,
      timestamp: Date.now(),
      state: {
        channels: this.getAllChannelPatterns(),
        effects: this.getAllEffects(),
        tempo: this.getCurrentTempo()
      }
    };

    this.snapshots.push(snapshot);
    return snapshot;
  }

  // Morph between snapshots
  morphToSnapshot(targetId: string, duration: number) {
    const target = this.snapshots.find(s => s.id === targetId);
    if (!target) return;

    const current = this.takeSnapshot('temp');
    const steps = 100;
    const stepDuration = duration / steps;

    for (let i = 0; i <= steps; i++) {
      setTimeout(() => {
        const t = i / steps;
        this.interpolateState(current.state, target.state, t);
      }, i * stepDuration);
    }
  }
}
```

### Controller-Specific Support
```typescript
// Ableton Push support
class AbletonPushSupport {
  private push: Push;

  initialize() {
    this.push = new Push();

    // Use the 8x8 pad grid for pattern triggers
    this.push.on('pad', (x, y, velocity) => {
      const index = y * 8 + x;
      this.triggerPattern(index, velocity);
    });

    // Encoders for effects
    this.push.on('encoder', (index, delta) => {
      const param = this.encoderMappings[index];
      this.adjustParameter(param, delta);
    });

    // Display pattern names on Push LCD
    this.updateDisplay();
  }

  updateDisplay() {
    this.push.lcd.line1 = 'd1: kick   d2: snare  d3: hats   d4: bass';
    this.push.lcd.line2 = 'BPM: 120   Key: Am    Bank: 1    Scene: A';
  }
}

// Novation Launchpad support
class LaunchpadSupport {
  private launchpad: Launchpad;
  private gridMode: 'patterns' | 'sequencer' | 'mixer' = 'patterns';

  setupGrid() {
    // Color code by pattern type
    this.colorScheme = {
      drums: 'red',
      bass: 'blue',
      melody: 'green',
      fx: 'yellow',
      empty: 'off'
    };

    // 8x8 grid layout
    this.gridLayout = [
      ['bd', 'sn', 'hh', 'ho', 'cp', 'rim', 'tom', 'cym'],  // Drums
      ['bass1', 'bass2', 'bass3', 'bass4', '', '', '', ''],  // Bass
      ['lead1', 'lead2', 'pad1', 'pad2', '', '', '', ''],    // Melody
      ['fx1', 'fx2', 'fx3', 'fx4', '', '', '', ''],          // FX
      ['', '', '', '', '', '', '', ''],                       // User 1
      ['', '', '', '', '', '', '', ''],                       // User 2
      ['scene1', 'scene2', 'scene3', 'scene4', '', '', '', ''], // Scenes
      ['stop', 'mute', 'solo', 'rec', 'bank-', 'bank+', 'shift', 'mode'] // Controls
    ];
  }
}
```

### MCP Tool Interface
```typescript
// Tools for Claude to use MIDI input
const midiTools = [
  {
    name: "midi_learn",
    description: "Start MIDI learn mode for a parameter",
    inputSchema: {
      properties: {
        channel: { type: "string" },
        parameter: { type: "string", enum: ["gain", "pan", "speed", "cutoff", "resonance", "delay", "room"] },
        range: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }
      }
    }
  },
  {
    name: "midi_map_list",
    description: "List all current MIDI mappings",
    inputSchema: {}
  },
  {
    name: "midi_map_remove",
    description: "Remove a MIDI mapping",
    inputSchema: {
      properties: {
        mappingId: { type: "string" }
      }
    }
  },
  {
    name: "midi_create_macro",
    description: "Create a macro that controls multiple parameters",
    inputSchema: {
      properties: {
        name: { type: "string" },
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              channel: { type: "string" },
              parameter: { type: "string" },
              min: { type: "number" },
              max: { type: "number" }
            }
          }
        }
      }
    }
  },
  {
    name: "midi_devices",
    description: "List available MIDI input devices",
    inputSchema: {}
  }
];
```

## Configuration File
```yaml
# midi-config.yaml
devices:
  - name: "Arturia MiniLab"
    mappings:
      - cc: 1
        channel: 1
        target: "d1.cutoff"
        range: [200, 10000]
        curve: exponential
      - cc: 2
        channel: 1
        target: "d1.resonance"
        range: [0, 0.9]
      - note: 36
        channel: 10
        target: "trigger"
        pattern: "bd bd ~ bd"
        channel: "d1"

  - name: "Launchpad Pro"
    mode: "grid"
    grid_size: [8, 8]
    banks:
      - name: "Drums"
        color: "red"
        patterns: ["bd*4", "sn*2", "hh*8", ...]
      - name: "Bass"
        color: "blue"
        patterns: ["bass1", "bass2", ...]

macros:
  - name: "Filter Sweep"
    targets:
      - "d1.cutoff": [200, 10000]
      - "d1.resonance": [0, 0.9]
      - "d2.cutoff": [500, 8000]

  - name: "Build Up"
    targets:
      - "d1.speed": [1, 2]
      - "d2.gain": [0.5, 1.5]
      - "d3.delay": [0, 0.5]
```

## Usage Examples

### For Claude
```
User: "Map my first knob to control the filter cutoff on d1"
Claude: I'll set up MIDI learn mode for the filter cutoff...
> midi_learn(channel: "d1", parameter: "cutoff", range: [200, 10000])
Now move the knob you want to use...
✓ Mapped CC1 on 'Arturia MiniLab' to d1.cutoff

User: "Create a macro that sweeps all the filters together"
Claude: Creating a filter sweep macro...
> midi_create_macro(
    name: "Master Filter",
    targets: [
      {channel: "d1", parameter: "cutoff", min: 200, max: 10000},
      {channel: "d2", parameter: "cutoff", min: 200, max: 10000},
      {channel: "d3", parameter: "cutoff", min: 500, max: 8000}
    ]
  )
✓ Created macro 'Master Filter' - map it to any MIDI control
```

### Benefits
1. **Physical Control** - Hands-on manipulation of patterns without typing
2. **Performance Ready** - Bank switching, snapshots, and scene triggers for live shows
3. **Intuitive Mapping** - MIDI learn mode makes setup quick
4. **Controller Support** - Native support for popular controllers
5. **Macro System** - Control multiple parameters with single knob/fader
6. **Visual Feedback** - LED feedback on supported controllers
7. **DAW Integration** - Use DAW automation to control Tidal patterns
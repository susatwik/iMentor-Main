#!/usr/bin/env python3
import os
import csv

# Define the B.Tech Electrical Engineering theory courses and their syllabi structure
EE_COURSES = {
    "EE1011 Basic Electrical Circuits": [
        # Module 1
        ("Module 1", "1", "Introduction to Circuit Elements", "Types of circuit components (R, L, C) and V-I relationships", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Independent and Dependent Sources", "Voltage and current sources, source transformations", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Kirchhoff's Laws", "Kirchhoff's Voltage Law (KVL) and Kirchhoff's Current Law (KCL)", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "Network Reduction Techniques", "Star-Delta transformations, series-parallel combinations", "R1 Ch2; R2 Lec4"),
        ("Module 1", "5", "Nodal Analysis", "Nodal analysis, concept of super-node", "R1 Ch3; R2 Lec5"),
        ("Module 1", "6", "Mesh Analysis", "Mesh analysis, concept of super-mesh", "R1 Ch3; R2 Lec6"),
        ("Module 1", "7", "Network Graphs", "Graph of a network, incidence matrix formation, equilibrium equations", "R1 Ch4; R2 Lec7"),
        ("Module 1", "8", "Dual Networks", "Concept and construction of dual networks", "R1 Ch4; R2 Lec8"),
        # Module 2
        ("Module 2", "9", "Alternating Quantities", "Average value, effective (RMS) value, form and peak factors for square, triangle, trapezoidal, and sinusoidal waveforms", "R1 Ch5; R2 Lec9"),
        ("Module 2", "10", "Phasor Representation", "Concept of phasors, phasor diagrams for R, L, C elements", "R1 Ch5; R2 Lec10"),
        ("Module 2", "11", "Single-Phase Series AC Circuits", "RL, RC, and RLC series circuits, impedance, voltage and current relations", "R1 Ch6; R2 Lec11"),
        ("Module 2", "12", "Single-Phase Parallel AC Circuits", "RL, RC, and RLC parallel circuits, admittance, phasor solutions", "R1 Ch6; R2 Lec12"),
        ("Module 2", "13", "Power Factor", "Active, reactive, and apparent power, concept and improvement of power factor", "R1 Ch7; R2 Lec13"),
        ("Module 2", "14", "Mesh and Nodal Analysis in AC", "Solution of AC networks using mesh and nodal analysis", "R1 Ch7; R2 Lec14"),
        # Module 3
        ("Module 3", "15", "Series Resonance", "Series resonant circuits, resonant frequency, bandwidth, Q-factor", "R1 Ch8; R2 Lec15"),
        ("Module 3", "16", "Parallel Resonance", "Parallel resonant circuits, selectivity, Q-factor, anti-resonance", "R1 Ch8; R2 Lec16"),
        # Module 4
        ("Module 4", "17", "Magnetic Circuits Fundamentals", "MMF, magnetic flux, reluctance, permeance, analogy with electric circuits", "R1 Ch9; R2 Lec17"),
        ("Module 4", "18", "Inductance Principles", "Faraday's laws of electromagnetic induction, Lenz's law, energy stored in magnetic field", "R1 Ch9; R2 Lec18"),
        ("Module 4", "19", "Self and Mutual Inductance", "Self-inductance, mutual inductance, coefficient of coupling, mutual flux", "R1 Ch10; R2 Lec19"),
        ("Module 4", "20", "Coupled Coils Connections", "Inductances in series and parallel, dot convention, cumulative and differential connection", "R1 Ch10; R2 Lec20"),
        ("Module 4", "21", "Electrical Safety", "Electrical shock, physiological effects, safety precautions", "R3 Ch1; R2 Lec21"),
        ("Module 4", "22", "Fuses and Earthing", "Fuses classification, selection, and application, concept and methods of earthing", "R3 Ch2; R2 Lec22")
    ],
    "EE1021 Analog Electronics": [
        # Module 1
        ("Module 1", "1", "BJT Biasing", "Biasing circuits of BJT, operating point, stability factor", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "BJT Amplifiers", "Analysis and design of small signal BJT amplifiers (CE, CB, CC)", "R1 Ch2; R2 Lec2"),
        ("Module 1", "3", "FET and MOSFET Amplifiers", "Biasing and small signal analysis of JFET and MOSFET amplifiers", "R1 Ch3; R2 Lec3"),
        ("Module 1", "4", "Class A Power Amplifiers", "Large signal amplifiers, series-fed and transformer-coupled class A amplifiers, efficiency", "R1 Ch4; R2 Lec4"),
        ("Module 1", "5", "Class B and Push-Pull Amplifiers", "Class B power amplifiers, push-pull operation, crossover distortion, efficiency", "R1 Ch4; R2 Lec5"),
        ("Module 1", "6", "Class C and Class D Amplifiers", "Operation, characteristics, and efficiency of Class C and Class D power amplifiers", "R1 Ch5; R2 Lec6"),
        # Module 2
        ("Module 2", "7", "Differential Amplifier", "DC and AC analysis of differential amplifiers, CMRR", "R1 Ch6; R2 Lec7"),
        ("Module 2", "8", "OP-AMP Characteristics", "Ideal and practical OP-AMP, input offset voltage, slew rate, frequency response", "R1 Ch6; R2 Lec8"),
        ("Module 2", "9", "OP-AMP Feedback", "Non-inverting and inverting voltage and current feedback configurations", "R1 Ch7; R2 Lec9"),
        ("Module 2", "10", "OP-AMP Linear Applications", "Amplifiers, summing amplifiers, voltage followers", "R1 Ch8; R2 Lec10"),
        ("Module 2", "11", "OP-AMP Integration & Differentiation", "Integrators and differentiators design and limitations", "R1 Ch8; R2 Lec11"),
        ("Module 2", "12", "OP-AMP Non-linear Applications", "Schmitt triggers, active filters, precision rectifiers", "R1 Ch9; R2 Lec12"),
        # Module 3
        ("Module 3", "13", "Feedback & Oscillators Concept", "Barkhausen criterion for oscillation, positive and negative feedback", "R1 Ch10; R2 Lec13"),
        ("Module 3", "14", "LC Oscillators", "Hartley and Colpitts oscillators design and working", "R1 Ch10; R2 Lec14"),
        ("Module 3", "15", "RC Oscillators", "RC phase shift and Wien bridge oscillators analysis", "R1 Ch11; R2 Lec15"),
        ("Module 3", "16", "Crystal Oscillators", "Quartz crystal construction, equivalent circuit, series and parallel resonance", "R1 Ch11; R2 Lec16"),
        # Module 4
        ("Module 4", "17", "Attenuators and RC Circuits", "RC integrator and differentiator circuits, high pass and low pass filters", "R1 Ch12; R2 Lec17"),
        ("Module 4", "18", "Diode Clippers & Clampers", "Diode clipping and clamping circuits, transfer characteristics", "R1 Ch12; R2 Lec18"),
        ("Module 4", "19", "Multivibrators", "Astable, monostable, and bistable multivibrators using transistors", "R1 Ch13; R2 Lec19"),
        ("Module 4", "20", "Schmitt Trigger and UJT Oscillator", "UJT relaxation oscillator, Schmitt trigger circuit operation", "R1 Ch13; R2 Lec20"),
        ("Module 4", "21", "555 Timer Applications", "Monostable and astable operation of 555 timers, circuit schematics", "R1 Ch14; R2 Lec21")
    ],
    "EE1031 Electrical Network Analysis": [
        # Module 1
        ("Module 1", "1", "Superposition and Reciprocity Theorems", "Statements, proofs, and application to DC and AC networks", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Thevenin's and Norton's Theorems", "Network equivalence, determination of Thevenin voltage and impedance", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Maximum Power Transfer Theorem", "Derivation for DC and AC circuits under various load conditions", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "Millman's and Tellegen's Theorems", "Statements, applications, and network conservation of energy verification", "R1 Ch2; R2 Lec4"),
        # Module 2
        ("Module 2", "5", "Transient Response of First-Order Circuits", "Solution of differential equations for RL and RC circuits with DC excitation", "R1 Ch3; R2 Lec5"),
        ("Module 2", "6", "Transient Response of Second-Order Circuits", "RLC series and parallel circuits response, overdamped, underdamped, and critically damped cases", "R1 Ch3; R2 Lec6"),
        ("Module 2", "7", "Initial Conditions Evaluation", "Evaluation of initial conditions in circuit elements at t=0+ and infinity", "R1 Ch4; R2 Lec7"),
        # Module 3
        ("Module 3", "8", "Laplace Transform in Network Analysis", "Laplace transforms of excitation signals (step, ramp, impulse, sinusoidal)", "R1 Ch5; R2 Lec8"),
        ("Module 3", "9", "Laplace Transformed Networks", "Representation of R, L, C elements and initial conditions in s-domain", "R1 Ch5; R2 Lec9"),
        ("Module 3", "10", "Waveform Synthesis", "Synthesis of non-sinusoidal waveforms using gate and step functions", "R1 Ch6; R2 Lec10"),
        ("Module 3", "11", "Impulse Response and Convolution", "Response for impulse function, relation to network admittance, convolution integral applications", "R1 Ch6; R2 Lec11"),
        # Module 4
        ("Module 4", "12", "Two-Port Z and Y Parameters", "Characterization, impedance and admittance parameter calculations", "R1 Ch7; R2 Lec12"),
        ("Module 4", "13", "Two-Port H and ABCD Parameters", "Hybrid and transmission parameters, physical significance", "R1 Ch7; R2 Lec13"),
        ("Module 4", "14", "Two-Port Interrelationships", "Inter-relationships and conversion formulas between parameters", "R1 Ch8; R2 Lec14"),
        ("Module 4", "15", "Interconnection of Two-Port Networks", "Series, parallel, and cascade interconnections", "R1 Ch8; R2 Lec15"),
        ("Module 4", "16", "Three-Phase Balanced Systems", "Balanced three-phase voltages, star-star and star-delta connections", "R1 Ch9; R2 Lec16"),
        ("Module 4", "17", "Three-Phase Unbalanced Systems", "Delta-delta and delta-star connections, power in balanced and unbalanced systems", "R1 Ch9; R2 Lec17")
    ],
    "EE2011 Measurements and Instrumentation": [
        # Module 1
        ("Module 1", "1", "Measurement Definitions", "Accuracy, tolerance, sensitivity, reproducibility, resolution", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Error Analysis", "Classification of errors, statistical analysis, limiting errors", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "PMMC Instruments", "Permanent Magnet Moving Coil: construction, working, torque equation", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "Moving Iron Instruments", "MI instruments: attraction and repulsion types, torque equation", "R1 Ch2; R2 Lec4"),
        ("Module 1", "5", "Electrodynamometer Instruments", "Construction, torque equation, use as ammeter, voltmeter, wattmeter", "R1 Ch3; R2 Lec5"),
        ("Module 1", "6", "Active and Reactive Power Measurement", "Single-phase and three-phase active and reactive power measurement", "R1 Ch3; R2 Lec6"),
        # Module 2
        ("Module 2", "7", "DC Bridges", "Wheatstone bridge, Kelvin's bridge, Kelvin's double bridge for low resistance", "R1 Ch4; R2 Lec7"),
        ("Module 2", "8", "High Resistance Measurement", "Megger, earth resistance measurement, loss of charge method", "R1 Ch4; R2 Lec8"),
        ("Module 2", "9", "AC Bridges for Inductance", "Maxwell's bridge, Hay's bridge, Anderson's bridge", "R1 Ch5; R2 Lec9"),
        ("Module 2", "10", "AC Bridges for Capacitance", "De-Sauty's bridge, Schering bridge, Wien bridge", "R1 Ch5; R2 Lec10"),
        # Module 3
        ("Module 3", "11", "Current Transformers", "CT: construction, working, ratio and phase angle errors", "R1 Ch6; R2 Lec11"),
        ("Module 3", "12", "Potential Transformers", "PT: construction, working, ratio and phase angle errors, testing", "R1 Ch6; R2 Lec12"),
        ("Module 3", "13", "Oscilloscopes", "Dual trace and dual beam CRO, voltage and frequency measurements", "R1 Ch7; R2 Lec13"),
        ("Module 3", "14", "Lissajous Patterns", "Phase and frequency measurement using Lissajous figures", "R1 Ch7; R2 Lec14"),
        ("Module 3", "15", "Electronic Meters", "Digital voltmeters, LCR meters, Q-meters", "R1 Ch8; R2 Lec15"),
        # Module 4
        ("Module 4", "16", "Digital Energy Meters", "Components, circuit diagram, software algorithms, AMR and AMI", "R1 Ch9; R2 Lec16"),
        ("Module 4", "17", "Temperature Transducers", "Thermistor, RTD, thermocouple principles and applications", "R1 Ch10; R2 Lec17"),
        ("Module 4", "18", "Displacement Transducers", "LVDT working principle, strain gauges, piezoelectric transducers", "R1 Ch10; R2 Lec18"),
        ("Module 4", "19", "Sensors", "Digital shaft encoders, tachometers, Hall effect sensors", "R1 Ch11; R2 Lec19")
    ],
    "EE2021 DC Machines and Transformers": [
        # Module 1
        ("Module 1", "1", "Energy Conversion Principles", "Review of electromagnetic fundamentals, magnetic circuit analysis", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "DC Machine Construction", "Yoke, poles, armature winding (lap and wave windings)", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "DC Generator Operation", "EMF equation, methods of excitation, magnetization characteristics", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "DC Motor Operation", "Back EMF, torque equation, torque-speed characteristics of shunt/series motors", "R1 Ch2; R2 Lec4"),
        ("Module 1", "5", "Armature Reaction", "Demagnetizing and cross-magnetizing effects, compensating windings", "R1 Ch3; R2 Lec5"),
        ("Module 1", "6", "Commutation Process", "Reactance voltage, methods of improving commutation, interpoles", "R1 Ch3; R2 Lec6"),
        # Module 2
        ("Module 2", "7", "DC Motor Speed Control", "Armature voltage control, flux control, Ward-Leonard system", "R1 Ch4; R2 Lec7"),
        ("Module 2", "8", "Losses and Efficiency", "Copper losses, iron losses, mechanical losses, efficiency curves", "R1 Ch4; R2 Lec8"),
        ("Module 2", "9", "DC Motor Starters", "3-point and 4-point starters operation and design", "R1 Ch5; R2 Lec9"),
        ("Module 2", "10", "Testing of DC Machines", "Swinburne's test, Hopkinson's test, Field's test", "R1 Ch5; R2 Lec10"),
        # Module 3
        ("Module 3", "11", "Single-Phase Transformer Construction", "Core and shell types, winding materials, EMF equation", "R1 Ch6; R2 Lec11"),
        ("Module 3", "12", "Transformer Equivalent Circuit", "Ideal transformer, equivalent circuit parameters referred to primary/secondary", "R1 Ch6; R2 Lec12"),
        ("Module 3", "13", "Phasor Diagrams", "Phasor diagrams under no-load and load (inductive, capacitive, resistive)", "R1 Ch7; R2 Lec13"),
        ("Module 3", "14", "Testing of Transformers", "OC and SC tests, efficiency and voltage regulation calculations", "R1 Ch7; R2 Lec14"),
        ("Module 3", "15", "Polarity and Sumpner's Test", "Polarity test, Sumpner's (back-to-back) test for temperature rise", "R1 Ch8; R2 Lec15"),
        ("Module 3", "16", "Parallel Operation & Auto-Transformers", "Conditions for parallel operation, auto-transformers copper saving", "R1 Ch8; R2 Lec16"),
        # Module 4
        ("Module 4", "17", "Three-Phase Transformer Construction", "3-phase core type and shell type, connections (Star/Delta)", "R1 Ch9; R2 Lec17"),
        ("Module 4", "18", "Three-Phase Connections Relations", "Voltage, current, and phase relations in Y-Y, Y-D, D-Y, D-D connections", "R1 Ch9; R2 Lec18"),
        ("Module 4", "19", "All-Day Efficiency", "Definition and calculations for fluctuating load cycles", "R1 Ch10; R2 Lec19"),
        ("Module 4", "20", "Special Connections", "Scott connection (3-phase to 2-phase conversion), tertiary windings", "R1 Ch10; R2 Lec20"),
        ("Module 4", "21", "Tap Changing & Cooling", "On-load and off-load tap changing, transformer cooling methods", "R1 Ch11; R2 Lec21")
    ],
    "EE2031 Power System Generation and Transmission": [
        # Module 1
        ("Module 1", "1", "Power System Layout", "Typical layout, transmission and distribution voltages, Indian power scenario", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Generation Stations", "Thermal, Hydro, Nuclear, Geothermal, and Gas turbine power plants", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Economics of Generation", "Definitions of load factor, demand factor, diversity factor, utilization factor", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "Load Duration Curves", "Plotting and utility of load duration curve, base and peak load plant selection", "R1 Ch2; R2 Lec4"),
        ("Module 1", "5", "Tariff and Economic Dispatch", "Types of tariffs (flat, block, two-part), basics of economic dispatch", "R1 Ch3; R2 Lec5"),
        # Module 2
        ("Module 2", "6", "Transmission Line Parameters - R", "DC and AC resistance, skin effect, proximity effect", "R1 Ch4; R2 Lec6"),
        ("Module 2", "7", "Transmission Line Parameters - L", "Self and mutual GMD, inductance of 1-phase and 3-phase symmetrical/asymmetrical lines", "R1 Ch4; R2 Lec7"),
        ("Module 2", "8", "Transmission Line Parameters - C", "Capacitance of 1-phase and 3-phase lines, effect of earth on capacitance", "R1 Ch5; R2 Lec8"),
        ("Module 2", "9", "Double Circuit Lines", "Inductance and capacitance calculations for double circuit lines", "R1 Ch5; R2 Lec9"),
        # Module 3
        ("Module 3", "10", "Short Transmission Lines", "Phasor diagram, efficiency, voltage regulation", "R1 Ch6; R2 Lec10"),
        ("Module 3", "11", "Medium Transmission Lines", "Nominal-T and Nominal-pi model analysis", "R1 Ch6; R2 Lec11"),
        ("Module 3", "12", "Long Transmission Lines", "Rigorous solution, wave propagation, propagation constant, characteristic impedance", "R1 Ch7; R2 Lec12"),
        ("Module 3", "13", "Power Flow & Circle Diagrams", "Receiving and sending end power circle diagrams", "R1 Ch7; R2 Lec13"),
        ("Module 3", "14", "Corona Effect", "Critical disruptive voltage, visual critical voltage, corona loss, minimization", "R1 Ch8; R2 Lec14"),
        ("Module 3", "15", "Insulators", "Types of insulators, voltage distribution in suspension insulator string", "R1 Ch8; R2 Lec15"),
        ("Module 3", "16", "String Efficiency & Sag", "Methods of improving string efficiency, sag and tension calculations (equal/unequal supports)", "R1 Ch9; R2 Lec16"),
        # Module 4
        ("Module 4", "17", "Underground Cables Construction", "Cable parts, core, insulation, metallic sheath, armouring", "R1 Ch10; R2 Lec17"),
        ("Module 4", "18", "Cables Electrical Characteristics", "Insulation resistance, capacitance of 1-core and 3-core cables", "R1 Ch10; R2 Lec18"),
        ("Module 4", "19", "Thermal and Potential Gradients", "Electrostatic stress, grading of cables (capacitance and intersheath grading)", "R1 Ch11; R2 Lec19")
    ],
    "EE2041 Digital Electronics": [
        # Module 1
        ("Module 1", "1", "Boolean Algebra Minimization", "Boolean identities, minimization of logic functions", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "K-Map Minimization", "Karnaugh maps (up to 5 variables), prime implicants, don't care conditions", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Logic Gates & Logic Families", "Logic gates, fan-in, fan-out, noise margin, TTL, CMOS families", "R1 Ch2; R2 Lec3"),
        # Module 2
        ("Module 2", "4", "Arithmetic Circuits", "Half adder, full adder, half subtractor, full subtractor, carry look-ahead adder", "R1 Ch3; R2 Lec4"),
        ("Module 2", "5", "Data Processors", "Multiplexers, demultiplexers, decoders, encoders, magnitude comparators", "R1 Ch3; R2 Lec5"),
        ("Module 2", "6", "Code Converters", "Binary to Gray, Gray to Binary, BCD to Excess-3 converter designs", "R1 Ch4; R2 Lec6"),
        # Module 3
        ("Module 3", "7", "Latches and Flip-Flops", "SR, JK, D, and T flip-flops, edge triggering, setup and hold times", "R1 Ch5; R2 Lec7"),
        ("Module 3", "8", "Asynchronous Counters", "Ripple counters, up/down counters, Modulo-N counters", "R1 Ch5; R2 Lec8"),
        ("Module 3", "9", "Synchronous Counters", "Design of synchronous counters, state table, excitation table, random sequence counter", "R1 Ch6; R2 Lec9"),
        ("Module 3", "10", "Shift Registers", "SISO, SIPO, PISO, PIPO registers, universal shift register", "R1 Ch6; R2 Lec10"),
        ("Module 3", "11", "ADC and DAC Converters", "R-2R ladder DAC, Successive Approximation ADC, Dual Slope ADC", "R1 Ch7; R2 Lec11"),
        ("Module 3", "12", "Semiconductor Memories", "ROM, RAM, SRAM, DRAM, flash memory structures", "R1 Ch7; R2 Lec12"),
        # Module 4
        ("Module 4", "13", "Programmable Logic Devices", "PROM, PLA, PAL, CPLD, and FPGA architectures", "R1 Ch8; R2 Lec13"),
        ("Module 4", "14", "Verilog HDL Introduction", "HDL advantages, structural, dataflow, and behavioral descriptions", "R1 Ch9; R2 Lec14"),
        ("Module 4", "15", "Combinational Design in Verilog", "Writing Verilog code for adders, decoders, and multiplexers", "R1 Ch9; R2 Lec15"),
        ("Module 4", "16", "Sequential Design in Verilog", "Writing Verilog code for flip-flops, registers, and counters", "R1 Ch10; R2 Lec16")
    ],
    "EE2051 AC Rotating Machines": [
        # Module 1
        ("Module 1", "1", "Induction Machine Construction", "Stator, squirrel cage and slip ring rotors, production of rotating magnetic field", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Operating Principle & Slip", "Concept of slip, rotor frequency, rotor EMF, equivalent circuit", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Torque-Slip Characteristics", "Torque equation, maximum torque, starting torque, stable/unstable zones", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "Testing of Induction Motor", "No-load and blocked rotor tests, circle diagram for performance predetermination", "R1 Ch2; R2 Lec4"),
        ("Module 1", "5", "Starting and Braking", "Star-delta, autotransformer, rotor resistance starters, plugging, dynamic braking", "R1 Ch3; R2 Lec5"),
        ("Module 1", "6", "Speed Control of Induction Motor", "Pole changing, stator voltage, V/f control, slip power recovery", "R1 Ch3; R2 Lec6"),
        # Module 2
        ("Module 2", "7", "Synchronous Generator Construction", "Salient pole and cylindrical rotors, winding factors (pitch and distribution factors)", "R1 Ch4; R2 Lec7"),
        ("Module 2", "8", "Voltage Regulation", "Armature reaction, synchronous impedance, EMF, MMF, Potier triangle methods", "R1 Ch4; R2 Lec8"),
        ("Module 2", "9", "Two-Reaction Theory", "Direct and quadrature axis reactances (Xd, Xq), slip test", "R1 Ch5; R2 Lec9"),
        ("Module 2", "10", "Parallel Operation", "Synchronizing power and torque, infinite bus operation, active/reactive power sharing", "R1 Ch5; R2 Lec10"),
        # Module 3
        ("Module 3", "11", "Synchronous Motor Operation", "Starting methods, torque-angle characteristics, phasor diagram", "R1 Ch6; R2 Lec11"),
        ("Module 3", "12", "Excitation Effects", "V-curves and inverted V-curves, synchronous condenser operation", "R1 Ch6; R2 Lec12"),
        ("Module 3", "13", "Permanent Magnet Excitation", "Concept of PM synchronous motors (PMSM), advantages", "R1 Ch7; R2 Lec13"),
        # Module 4
        ("Module 4", "14", "Single-Phase Induction Motors", "Double revolving field theory, equivalent circuit, no-load and blocked rotor tests", "R1 Ch8; R2 Lec14"),
        ("Module 4", "15", "Starting Methods (1-Phase)", "Split-phase, capacitor-start, capacitor-run, shaded-pole motors, applications", "R1 Ch8; R2 Lec15")
    ],
    "EE2061 Control Systems": [
        # Module 1
        ("Module 1", "1", "Introduction to Control Systems", "Open loop and closed loop control, feedback effects", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Mathematical Modeling", "Differential equations of electrical and mechanical systems, force-voltage analogy", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Transfer Function", "Definition, transfer function of physical systems, servomotors, synchro pair", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "Block Diagram Reduction", "Block diagram representation and block diagram algebra rules", "R1 Ch2; R2 Lec4"),
        ("Module 1", "5", "Signal Flow Graphs", "Nodes, branches, loops, Mason's gain formula", "R1 Ch3; R2 Lec5"),
        # Module 2
        ("Module 2", "6", "Standard Test Signals", "Step, ramp, parabolic, and impulse excitation definitions", "R1 Ch4; R2 Lec6"),
        ("Module 2", "7", "Transient Response", "First-order and second-order systems transient response, time domain specifications", "R1 Ch4; R2 Lec7"),
        ("Module 2", "8", "Steady-State Errors", "Type and order of systems, static error constants, steady-state error analysis", "R1 Ch5; R2 Lec8"),
        ("Module 2", "9", "Controllers", "Proportional (P), Integral (I), Derivative (D), PI, PD, PID control action", "R1 Ch5; R2 Lec9"),
        ("Module 2", "10", "Routh-Hurwitz Stability", "Concept of absolute stability, RH criterion, special cases", "R1 Ch6; R2 Lec10"),
        # Module 3
        ("Module 3", "11", "Root Locus Method", "Angle and magnitude conditions, root locus construction rules", "R1 Ch7; R2 Lec11"),
        ("Module 3", "12", "Root Locus Analysis", "Effects of adding poles and zeros, dominant poles concept", "R1 Ch7; R2 Lec12"),
        ("Module 3", "13", "Frequency Response Introduction", "Frequency domain specifications, correlation with time domain", "R1 Ch8; R2 Lec13"),
        ("Module 3", "14", "Bode Plots", "Magnitude and phase plots, gain margin, phase margin, stability analysis", "R1 Ch8; R2 Lec14"),
        ("Module 3", "15", "Nyquist Stability Criterion", "Nyquist path, polar plots, encirclements, stability analysis", "R1 Ch9; R2 Lec15"),
        ("Module 3", "16", "Compensator Design", "Lead, lag, and lead-lag compensation using Bode/Nyquist methods", "R1 Ch9; R2 Lec16"),
        # Module 4
        ("Module 4", "17", "State Space Representation", "State variables, state vectors, state equations formulation", "R1 Ch10; R2 Lec17"),
        ("Module 4", "18", "Transfer Function s-Domain Conversions", "Converting state space to transfer function and vice-versa", "R1 Ch10; R2 Lec18"),
        ("Module 4", "19", "State Equations Solution", "State transition matrix, Laplace and time-domain solution of state equations", "R1 Ch11; R2 Lec19"),
        ("Module 4", "20", "Controllability and Observability", "Kalman's and Gilbert's tests for controllability and observability", "R1 Ch11; R2 Lec20")
    ],
    "EE2071 Power System Analysis": [
        # Module 1
        ("Module 1", "1", "Per-Unit Calculations", "One-line diagram, impedance diagram, base quantities, base change formulas", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Bus Admittance Matrix", "Y-bus formation by inspection and singular transformation methods", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Bus Impedance Matrix", "Z-bus building algorithm for various modifications", "R1 Ch2; R2 Lec3"),
        # Module 2
        ("Module 2", "4", "Load Flow Problem", "Bus classification (PQ, PV, Slack), static load flow equations", "R1 Ch3; R2 Lec4"),
        ("Module 2", "5", "Gauss-Seidel Method", "Algorithm, flow chart, iterative calculations", "R1 Ch3; R2 Lec5"),
        ("Module 2", "6", "Newton-Raphson Method", "Rectangular and polar coordinates, Jacobian matrix, algorithm", "R1 Ch4; R2 Lec6"),
        ("Module 2", "7", "Fast Decoupled Load Flow", "Assumptions, decoupled equations, algorithm", "R1 Ch4; R2 Lec7"),
        ("Module 2", "8", "Distribution Load Flow", "Backward-forward sweep method for radial distribution networks", "R1 Ch5; R2 Lec8"),
        # Module 3
        ("Module 3", "9", "Symmetrical Components", "Positive, negative, and zero sequence components, sequence transformation", "R1 Ch6; R2 Lec9"),
        ("Module 3", "10", "Sequence Networks", "Sequence impedances of generator, transformer, and transmission lines", "R1 Ch6; R2 Lec10"),
        ("Module 3", "11", "Symmetrical Fault Analysis", "3-phase short circuit, sub-transient, transient, steady-state currents, short circuit capacity", "R1 Ch7; R2 Lec11"),
        ("Module 3", "12", "Unsymmetrical LG Faults", "Single line-to-ground fault analysis, connection of sequence networks", "R1 Ch7; R2 Lec12"),
        ("Module 3", "13", "Unsymmetrical LL & LLG Faults", "Line-to-line and double line-to-ground fault analyses", "R1 Ch8; R2 Lec13"),
        # Module 4
        ("Module 4", "14", "Power System Stability", "Classification, swing equation derivation, power-angle equation", "R1 Ch9; R2 Lec14"),
        ("Module 4", "15", "Equal Area Criterion", "EAC statement, application to sudden change in load, fault clearance", "R1 Ch9; R2 Lec15"),
        ("Module 4", "16", "Numerical Solution of Swing Equation", "Step-by-step method, Euler method, Runge-Kutta method", "R1 Ch10; R2 Lec16"),
        ("Module 4", "17", "Stability Improvement", "Methods to improve steady-state and transient stability, voltage stability concepts", "R1 Ch10; R2 Lec17")
    ],
    "EE3011 Power Electronics": [
        # Module 1
        ("Module 1", "1", "Power Switches Characteristics", "V-I characteristics of power diode, SCR, BJT, MOSFET, IGBT", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "SCR Commutation", "Line commutation, forced commutation methods (Class A to F)", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Gate Drive Circuits", "SCR turn-on methods, gate drive circuits, isolation, protection", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "Switching Losses & Datasheets", "Conduction and switching losses, thermal design, heatsinks", "R1 Ch2; R2 Lec4"),
        ("Module 1", "5", "Converter Classifications", "AC-DC, DC-DC, DC-AC, AC-AC converters basic configurations", "R1 Ch3; R2 Lec5"),
        # Module 2
        ("Module 2", "6", "1-Phase Half-Controlled Rectifiers", "Semi-converter operation with R, RL, and RLE load", "R1 Ch4; R2 Lec6"),
        ("Module 2", "7", "1-Phase Fully-Controlled Rectifiers", "Full-converter operation with RL and RLE load, freewheeling diode", "R1 Ch4; R2 Lec7"),
        ("Module 2", "8", "3-Phase Fully-Controlled Rectifiers", "Operation with RLE load, output voltage expression", "R1 Ch5; R2 Lec8"),
        ("Module 2", "9", "Source Inductance Effect", "Overlap angle, voltage reduction in controlled converters", "R1 Ch5; R2 Lec9"),
        # Module 3
        ("Module 3", "10", "1-Phase Bridge Inverters", "Half bridge and full bridge configurations with R and RL load", "R1 Ch6; R2 Lec10"),
        ("Module 3", "11", "3-Phase Bridge Inverters", "180-degree and 120-degree conduction mode analysis", "R1 Ch6; R2 Lec11"),
        ("Module 3", "12", "Pulse Width Modulation", "Single, multiple, and sinusoidal PWM techniques, harmonic index", "R1 Ch7; R2 Lec12"),
        ("Module 3", "13", "PWM Control Schemes", "Unipolar and bipolar voltage switching schemes", "R1 Ch7; R2 Lec13"),
        # Module 4
        ("Module 4", "14", "Non-Isolated DC-DC Converters - Buck", "Step-down converter operation in continuous and discontinuous modes", "R1 Ch8; R2 Lec14"),
        ("Module 4", "15", "Non-Isolated DC-DC Converters - Boost", "Step-up converter operation, output ripple calculation", "R1 Ch8; R2 Lec15"),
        ("Module 4", "16", "Buck-Boost Converter", "Inverting regulator operation, critical inductance/capacitance", "R1 Ch9; R2 Lec16"),
        ("Module 4", "17", "Cuk and Sepic Converters", "Advanced DC-DC converters configuration and operating waveforms", "R1 Ch9; R2 Lec17")
    ],
    "EE3021 Power System Protection and Control": [
        # Module 1
        ("Module 1", "1", "Relay Protection Principles", "Zones of protection, primary and backup protection, relay terminology", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Instrument Transformers", "CT and VT behavior under fault conditions, errors", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Overcurrent Relays", "Electromagnetic attraction and induction relays, IDMT characteristics", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "Distance Relays", "Impedance, reactance, Mho relays characteristics, settings", "R1 Ch2; R2 Lec4"),
        ("Module 1", "5", "Differential Protection", "Simple differential relay, percentage biased differential relay", "R1 Ch3; R2 Lec5"),
        ("Module 1", "6", "Circuit Breakers", "Arc interruption theory, RRRV, air blast, SF6, vacuum circuit breakers", "R1 Ch3; R2 Lec6"),
        # Module 2
        ("Module 2", "7", "Generator Protection", "Stator faults (Merz-Price), rotor faults, unbalanced loading protection", "R1 Ch4; R2 Lec7"),
        ("Module 2", "8", "Transformer Protection", "Biased differential protection, Buchholz relay, magnetizing inrush", "R1 Ch4; R2 Lec8"),
        ("Module 2", "9", "Line and Busbar Protection", "Carrier current protection, differential busbar protection", "R1 Ch5; R2 Lec9"),
        ("Module 2", "10", "Motor and Capacitor Protection", "Overload, single-phasing protection, capacitor bank protection", "R1 Ch5; R2 Lec10"),
        # Module 3
        ("Module 3", "11", "Load Frequency Control", "Single area system LFC, speed governor model, tie-line bias control", "R1 Ch6; R2 Lec11"),
        ("Module 3", "12", "LFC Dynamics", "Two-area system LFC, frequency deviation, automatic generation control", "R1 Ch6; R2 Lec12"),
        ("Module 3", "13", "Voltage Control", "AVR loop modeling, voltage control methods (tap chargers, shunt reactors)", "R1 Ch7; R2 Lec13"),
        ("Module 3", "14", "Reactive Power Compensation", "Static VAR compensators (SVC, STATCOM), capacitor placement", "R1 Ch7; R2 Lec14"),
        # Module 4
        ("Module 4", "15", "Economic Dispatch Formulation", "Incremental fuel cost, transmission losses expression, coordinate equations", "R1 Ch8; R2 Lec15"),
        ("Module 4", "16", "Locational Marginal Pricing", "LMP concept, congestion cost, pricing-based dispatch", "R1 Ch8; R2 Lec16"),
        ("Module 4", "17", "Unit Commitment", "Constraints (minimum up/down times, startup costs), dynamic programming solution", "R1 Ch9; R2 Lec17")
    ],
    "EE3031 Embedded Systems": [
        # Module 1
        ("Module 1", "1", "Microcontroller Fundamentals", "Microprocessor vs microcontroller, Harvard vs Von-Neumann architectures", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Embedded Systems Characteristics", "Definition, constraints, dynamic/static scheduling", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Software Development Models", "Waterfall, V-model, software unit testing practices", "R1 Ch2; R2 Lec3"),
        # Module 2
        ("Module 2", "4", "ARM Cortex-M4 Architecture", "ARM processor series, Cortex-M4 block diagram, register set", "R1 Ch3; R2 Lec4"),
        ("Module 2", "5", "Memory Map & Bitbanding", "Cortex-M4 memory mapping, bit-band region operations", "R1 Ch3; R2 Lec5"),
        # Module 3
        ("Module 3", "6", "ARM Instruction Set", "ARM and Thumb instructions, instruction format", "R1 Ch4; R2 Lec6"),
        ("Module 3", "7", "Data Processing Instructions", "Arithmetic, logical, shift, rotate, and bit-field instructions", "R1 Ch4; R2 Lec7"),
        ("Module 3", "8", "Control and Branch Instructions", "Conditional branching, loop control, floating point operations", "R1 Ch5; R2 Lec8"),
        # Module 4
        ("Module 4", "9", "GPIO Interfacing", "GPIO port circuitry, input/output/alternate function configuration", "R1 Ch6; R2 Lec9"),
        ("Module 4", "10", "Interrupt Handling", "Exceptions vector table, NVIC, nesting, exception entry/exit overhead", "R1 Ch6; R2 Lec10"),
        ("Module 4", "11", "ADC and DAC Interfacing", "Analog-to-digital and digital-to-analog converter interface circuits", "R1 Ch7; R2 Lec11"),
        ("Module 4", "12", "Timers & PWM Modules", "System tick timer, low power timers, watchdog timer, PWM generation", "R1 Ch7; R2 Lec12"),
        ("Module 4", "13", "Serial Communication Interfacing", "UART, SPI, and I2C protocols and register settings", "R1 Ch8; R2 Lec13")
    ],
    "EE3041 Electric Power Drives": [
        # Module 1
        ("Module 1", "1", "Introduction to Electric Drives", "Definition, parts, advantages, choice of electric motor", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Dynamics of Motor-Load System", "Equivalent torque, speed-torque quadrant operation, selection of drive rating", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Rectifier-Controlled DC Drives", "1-phase and 3-phase fully-controlled rectifiers feeding DC motors (continuous/discontinuous mode)", "R1 Ch2; R2 Lec3"),
        ("Module 1", "4", "Chopper-Controlled DC Drives", "Chopper circuits (Class A to E) feeding DC motors, regenerative braking", "R1 Ch2; R2 Lec4"),
        # Module 2
        ("Module 2", "5", "Induction Motor V/f Control", "Stator voltage control, variable frequency control, V/f ratio maintenance", "R1 Ch3; R2 Lec5"),
        ("Module 2", "6", "Rotor Resistance Speed Control", "Static rotor resistance control, chopper circuit design", "R1 Ch3; R2 Lec6"),
        ("Module 2", "7", "Slip Power Recovery Schemes", "Kramer and Scherbius drive systems operation", "R1 Ch4; R2 Lec7"),
        # Module 3
        ("Module 3", "8", "Field Oriented Control", "Vector control principles, d-q coordinate transformation, direct and indirect FOC", "R1 Ch5; R2 Lec8"),
        ("Module 3", "9", "Direct Torque Control", "DTC principle, stator flux and torque estimation, switching table", "R1 Ch5; R2 Lec9"),
        ("Module 3", "10", "Sensorless Control", "Speed sensorless control techniques, MRAS, sliding mode observers", "R1 Ch6; R2 Lec10"),
        # Module 4
        ("Module 4", "11", "Permanent Magnet Motors Configuration", "BLDC and PMSM motor configurations, operating principles", "R1 Ch7; R2 Lec11"),
        ("Module 4", "12", "PM Synchronous Motor Drives", "Vector control of PMSM drives, constant torque and flux weakening region control", "R1 Ch7; R2 Lec12")
    ],
    "EE2601 Network Analysis (for ECE)": [
        # Module 1
        ("Module 1", "1", "Circuit Elements", "Types of circuit components, independent and dependent sources", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Source Transformations", "Source equivalence and conversions, KVL and KCL applications", "R1 Ch1; R2 Lec2"),
        ("Module 1", "3", "Loop and Node Equations", "Mesh and nodal analysis, loop and node equation formulation", "R1 Ch2; R2 Lec3"),
        # Module 2
        ("Module 2", "4", "Transient Initial Conditions", "Initial condition evaluation for inductors and capacitors", "R1 Ch3; R2 Lec4"),
        ("Module 2", "5", "RL Transient Response", "RL circuit analysis under DC, step, and exponential excitations", "R1 Ch3; R2 Lec5"),
        ("Module 2", "6", "RC Transient Response", "RC circuit analysis under DC and sinusoidal excitations", "R1 Ch4; R2 Lec6"),
        # Module 3
        ("Module 3", "7", "AC Phasor Analysis", "Phasor domain representation, complex power, power factor", "R1 Ch5; R2 Lec7"),
        ("Module 3", "8", "Resonance Circuits", "Series and parallel resonance, bandwidth, selectivity, Q-factor", "R1 Ch5; R2 Lec8"),
        ("Module 3", "9", "Laplace Transform Application", "Laplace transform solution of linear differential equations for RL, RC networks", "R1 Ch6; R2 Lec9"),
        # Module 4
        ("Module 4", "10", "Network Theorems ECE", "Thevenin's, Norton's, Star-Delta, Tellegen's, and Reciprocity theorems", "R1 Ch7; R2 Lec10"),
        ("Module 4", "11", "Two-Port Network Parameters", "Z, Y, H, ABCD parameters calculation, interrelations", "R1 Ch8; R2 Lec11")
    ],
    "EE1611 Basics of Electrical Engineering (for Civil Engineering)": [
        # Module 1
        ("Module 1", "1", "DC Circuits", "Kirchhoff's voltage and current laws, network reduction", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "Network Theorems Civil", "Superposition theorem and Star-Delta transformations", "R1 Ch1; R2 Lec2"),
        # Module 2
        ("Module 2", "3", "AC Fundamentals", "Phasor representation of AC quantities, complex impedance", "R1 Ch2; R2 Lec3"),
        ("Module 2", "4", "AC Power", "Real power, reactive power, power factor, series-parallel AC circuits", "R1 Ch2; R2 Lec4"),
        # Module 3
        ("Module 3", "5", "Single-Phase Transformers", "Operating principle, EMF equation, phasor diagram, equivalent circuit, voltage regulation, efficiency", "R1 Ch3; R2 Lec5"),
        ("Module 3", "6", "DC Machines Civil", "Construction, generator/motor operation, EMF and torque equations, motor characteristics, speed control", "R1 Ch3; R2 Lec6"),
        # Module 4
        ("Module 4", "7", "AC Rotating Machines Civil", "3-phase induction motor principle, torque-speed characteristics, 1-phase induction motor starting, applications", "R1 Ch4; R2 Lec7"),
        ("Module 4", "8", "Fuses and Safety", "Electrical shock hazards, fuses, and earthing techniques", "R1 Ch4; R2 Lec8")
    ],
    "EE1621 Introduction to Electrical & Electronics Engineering (for Mechanical Engg.)": [
        # Module 1
        ("Module 1", "1", "Circuit Laws & Theorems Mech", "KVL, KCL, superposition theorem, star-delta transformations", "R1 Ch1; R2 Lec1"),
        ("Module 1", "2", "AC Circuits Mech", "Phasor representation, complex impedance, power factor, 1-phase series/parallel solutions", "R1 Ch1; R2 Lec2"),
        # Module 2
        ("Module 2", "3", "Transformers Mech", "1-phase transformer working, EMF equation, equivalent circuit, regulation, and efficiency", "R1 Ch2; R2 Lec3"),
        # Module 3
        ("Module 3", "4", "DC Machines Mech", "Construction, EMF/torque equations, shunt/series motor characteristics, speed control", "R1 Ch3; R2 Lec4"),
        ("Module 3", "5", "AC Machines Mech", "3-phase induction motor operation, torque-speed characteristics, 1-phase motor starting", "R1 Ch3; R2 Lec5"),
        # Module 4
        ("Module 4", "6", "P-N Junction Diodes", "Working principle, forward/reverse bias I-V characteristics", "R1 Ch4; R2 Lec6"),
        ("Module 4", "7", "Bipolar Junction Transistors", "BJT operation, CE, CB, CC configuration characteristics", "R1 Ch4; R2 Lec7")
    ]
}

def generate_csvs():
    bootstrap_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "course_bootstrap"))
    os.makedirs(bootstrap_dir, exist_ok=True)
    print(f"Generating syllabi CSVs under: {bootstrap_dir}")
    
    headers = ["Module", "Lecture Number", "Lecture Topic", "Subtopics", "Resources"]
    
    for course_name, entries in EE_COURSES.items():
        course_folder = os.path.join(bootstrap_dir, course_name)
        os.makedirs(course_folder, exist_ok=True)
        
        # Create materials folder
        materials_folder = os.path.join(course_folder, "materials")
        os.makedirs(materials_folder, exist_ok=True)
        
        # Write syllabus.csv
        csv_path = os.path.join(course_folder, "syllabus.csv")
        with open(csv_path, mode="w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(headers)
            for entry in entries:
                writer.writerow(entry)
                
        print(f"Created course bootstrap folders for: {course_name}")

if __name__ == "__main__":
    generate_csvs()

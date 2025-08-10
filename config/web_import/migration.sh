#!/bin/bash
# Custom migration rules
# Add your custom transformations here

# Example: Add custom includes after the standard includes
sed -i '/#include <dt-bindings\/zmk\/outputs.h>/a\
\
// Custom includes\
#include "includes/behaviors.dtsi"\
#include "includes/combos.dtsi"\
#include "includes/macros.dtsi"' "$1"

# Example: Replace specific key bindings
# sed -i 's/&kp LCTRL/&hml LCTRL/g' "$1"

echo "Custom migrations applied."

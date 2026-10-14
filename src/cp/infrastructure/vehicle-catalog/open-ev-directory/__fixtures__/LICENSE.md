# Open EV Directory contract fixtures

The JSON files in this directory are copies of the response examples
published by the Open EV Vehicle Directory API
(<https://github.com/juherr/open-ev-directory>,
`app/src/main/resources/openapi/examples/`), reformatted by this repository's
formatter and otherwise unchanged. They are test data only, used to
pin the simulator's adapter to the API contract (#458).

They contain vehicle data from two upstream sources, each under its own terms,
as every response states in its `licenses` member:

- **EVDB (Gaia)** — © EVDB contributors, <https://github.com/gaia-charge/evdb>,
  licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
  Modified by Open EV Directory: normalised to its schema.
- **Open EV Data (KilowattApp)** — Copyright (c) 2024 Tijs Teulings,
  <https://github.com/KilowattApp/open-ev-data>, MIT License with Attribution
  Requirement.

Variants of these files built inside the tests (a missing capacity, an
estimated curve, a curve above the DC maximum) are derived from the same data
and fall under the same terms.

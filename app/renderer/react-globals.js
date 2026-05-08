/* Expose React's hooks as window globals so each pre-compiled component
   script can use bare `useState`, `useEffect`, `useRef`, `useMemo` at the
   top level without explicit imports.

   Why: the R&D prototype loads each component as a `<script type="text/babel">`
   tag and Babel-standalone's in-browser transform leaks the destructured
   hook bindings across scripts. Babel CLI's compiled output keeps `const`
   block-scoped, so we need this small global bridge to keep the components
   verbatim instead of editing every file. */

Object.assign(window, {
  useState:    React.useState,
  useEffect:   React.useEffect,
  useRef:      React.useRef,
  useMemo:     React.useMemo,
  useCallback: React.useCallback,
  useContext:  React.useContext,
  useReducer:  React.useReducer,
  Fragment:    React.Fragment,
});

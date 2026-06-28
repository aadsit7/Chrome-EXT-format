// config.js — single source of truth for Sharon's backend address.
//
// Sharon never contains an API key. It POSTs the question and the page text to
// this Google Apps Script web app, which adds the secret key and calls the AI.
export const PROXY_URL =
  "https://script.google.com/macros/s/AKfycbwzjjbdykzzh60zIfPBvU6RA02RzMjvxbVnwW8OC4zTAxOmgivofmHq9xCDLliVxXZiog/exec";

// Cap the amount of page text we send so requests stay reasonable.
export const MAX_PAGE_TEXT = 45000;

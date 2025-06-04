exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('scan_results', {
    page_screenshot: { type: 'text' } // Column to store base64 encoded screenshot
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('scan_results', 'page_screenshot');
}; 
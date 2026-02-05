 #!/bin/bash
  # Fix workflow references to use remote reusable workflows

  for file in .github/workflows/*.yml; do
    echo "Processing $file..."

    # Replace local reusable workflow references with remote
    sed -i.bak \
      -e 's|uses: \./\.github/workflows/reusable-\(.*\)\.yml|uses: iamkayleb/Workflows/.github/workflows/reusable-\1.yml@v1|g' \
      "$file"

    # Remove backup
    rm -f "${file}.bak"
  done

  echo "Done! Workflow references updated to use iamkayleb/Workflows@v1"
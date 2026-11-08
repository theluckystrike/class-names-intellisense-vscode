<?php $collapsed = isset($_GET['c']); ?>
<!DOCTYPE html>
<html>
<head><link rel="stylesheet" href="styles/theme.css"></head>
<body>
  <aside id="sidebar">
    <div class="panel <?php echo $collapsed ? 'is-collapsed' : ''; ?> ">
      <div class="panel-header">Filters</div>
      <div class="panel-body">
        <div class="alert alert-info">Pick a date range.</div>
      </div>
    </div>
  </aside>
</body>
</html>
